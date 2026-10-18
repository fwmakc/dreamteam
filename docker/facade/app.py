"""
Тонкий facade над diffusers: принимает наш OpenAI-подобный JSON и возвращает PNG в base64.
Одна и та же обертка обслуживает и CPU-тест (sd-turbo), и GPU-модели (FLUX, Qwen-Image-Edit) —
меняется только переменная окружения MODELS при запуске контейнера (см. ../compose.yaml).

POST /v1/images/generations  {model, prompt, n, size, steps?, guidance?, seed?}
POST /v1/images/edits        {model, prompt, image: [data:URL, ...], n, size, steps?, ...}
Ответ:                       {"data": [{"b64_json": "..."}]}
"""

import base64
import io
import os
import re
import threading

import torch
from PIL import Image
from diffusers import AutoPipelineForImage2Image, AutoPipelineForText2Image
from fastapi import FastAPI, HTTPException
from pydantic import BaseModel

# Список моделей: "имя=вид:repo", через запятую.
# Виды: sd — текст2картинка и перерисовка (AutoPipeline: sd-turbo, FLUX, SD1.5...);
#       edit — перерисовка Qwen-Image-Edit (свой пайплайн, принимает несколько референсов).
MODELS: dict[str, tuple[str, str]] = {}
for pair in os.environ.get("MODELS", "sd-turbo=sd:stabilityai/sd-turbo").split(","):
    if "=" in pair:
        name, spec = pair.split("=", 1)
        kind, _, repo = spec.partition(":")
        MODELS[name.strip()] = (kind.strip(), repo.strip())

DEVICE = os.environ.get("DEVICE", "cuda" if torch.cuda.is_available() else "cpu")
DTYPE = torch.float16 if DEVICE == "cuda" else torch.float32
IMG2IMG_STRENGTH = float(os.environ.get("IMG2IMG_STRENGTH", "0.55"))

# Умолчания по виду модели: шаги и guidance, если агент их не прислал.
# turbo/schnell обязаны ходить без classifier-free guidance (guidance 0) —
# иначе получаются пересвеченные артефакты.
KIND_DEFAULTS: dict[str, dict[str, float]] = {
    "sd-turbo": {"num_inference_steps": 4, "guidance_scale": 0.0},
    "flux-schnell": {"num_inference_steps": 4, "guidance_scale": 0.0},
    "flux": {"num_inference_steps": 28, "guidance_scale": 3.5},
    "photomaker": {"num_inference_steps": 30, "guidance_scale": 5.0},
    # черновое качество для слабых CPU: BK-SDM — SD1.5 с вырезанными блоками UNet
    "sd-small": {"num_inference_steps": 25, "guidance_scale": 7.5},
}

# LCM-адаптер (env LCM_LORA — репозиторий LoRA) превращает SD-семейство в
# few-step: 4–8 шагов с guidance 1–2 вместо 20–50. Умолчания качества в этом
# режиме другие — CFG почти не используется.
LCM_DEFAULTS: dict[str, float] = {"num_inference_steps": 6, "guidance_scale": 1.5}
LCM_LORA = os.environ.get("LCM_LORA", "")

app = FastAPI(title="dreamteam image facade")
_lock = threading.Lock()
_text2img: dict[str, object] = {}
_img2img: dict[str, object] = {}
_lcm_repos: set[str] = set()


def place(pipe):
    """Раскладывает пайплайн по железу. На GPU — с offload: компоненты приезжают
    на карту по очереди, поэтому FLUX влезает в карту от ~16 ГБ, а не 24.
    На CPU — режем внимание на куски: ниже пик потребления RAM."""
    if DEVICE == "cpu":
        pipe.to("cpu")
        pipe.enable_attention_slicing()
    else:
        pipe.enable_model_cpu_offload()
    return pipe


def load_pipeline(kind: str, repo: str):
    with _lock:
        if kind == "edit":
            from diffusers import QwenImageEditPlusPipeline
            if repo not in _text2img:
                pipe = QwenImageEditPlusPipeline.from_pretrained(
                    repo, torch_dtype=torch.bfloat16, low_cpu_mem_usage=True)
                place(pipe)
                _text2img[repo] = pipe
            return _text2img[repo]
        if kind == "photomaker":
            from diffusers import PhotoMakerPipeline
            if repo not in _text2img:
                pipe = PhotoMakerPipeline.from_pretrained(repo, torch_dtype=DTYPE, low_cpu_mem_usage=True)
                pipe.load_photomaker_adapter(
                    os.environ.get("PHOTO_REPO", "TencentARC/PhotoMaker-V2"),
                    subfolder="",
                    weight_name=os.environ.get("PHOTO_WEIGHT", "photomaker-v2.bin"),
                    trigger_word="img",  # это слово в промпте — место, куда встраивается лицо
                )
                place(pipe)
                _text2img[repo] = pipe
            return _text2img[repo]
        # остальные виды — AutoPipeline: покрывает SD-семейство, sd-turbo и FLUX
        if repo not in _text2img:
            pipe = AutoPipelineForText2Image.from_pretrained(repo, torch_dtype=DTYPE, low_cpu_mem_usage=True)
            place(pipe)
            _maybe_lcm(pipe, repo)
            _text2img[repo] = pipe
        return _text2img[repo]


def load_img2img(repo: str):
    with _lock:
        if repo not in _img2img:
            pipe = AutoPipelineForImage2Image.from_pretrained(repo, torch_dtype=DTYPE, low_cpu_mem_usage=True)
            place(pipe)
            _maybe_lcm(pipe, repo)
            _img2img[repo] = pipe
        return _img2img[repo]


def _with_trigger(prompt: str) -> str:
    return prompt if re.search(r"\bimg\b", prompt) else f"a photo of img, {prompt}"


def _maybe_lcm(pipe, repo: str) -> None:
    """Опциональный LCM-адаптер (env LCM_LORA): SD-модель начинает ходить
    за 4–8 шагов. Для edit/photomaker не вызывается. Сами шаги резать у
    BK-SDM бесполезно — он сжат по архитектуре, а не по числу шагов."""
    if LCM_LORA:
        pipe.load_lora_weights(LCM_LORA)
        from diffusers import LCMScheduler
        pipe.scheduler = LCMScheduler.from_config(pipe.scheduler.config)
        _lcm_repos.add(repo)


def parse_size(size: str) -> tuple[int, int]:
    try:
        w, _, h = size.lower().partition("x")
        return max(int(w) // 8 * 8, 64), max(int(h) // 8 * 8, 64)
    except ValueError:
        raise HTTPException(400, f"не понял size {size!r} — жду формат «512x768»")


def decode_dataurl(u: str) -> Image.Image:
    try:
        _, _, b64 = u.partition(",")
        return Image.open(io.BytesIO(base64.b64decode(b64))).convert("RGB")
    except Exception:
        raise HTTPException(400, "не смог прочитать референс: жду data:URL с base64")


def encode_png(img: Image.Image) -> str:
    buf = io.BytesIO()
    img.save(buf, format="PNG")
    return base64.b64encode(buf.getvalue()).decode()


class GenRequest(BaseModel):
    model: str = "sd-turbo"
    prompt: str
    n: int = 1
    size: str = "512x512"
    steps: int | None = None
    guidance: float | None = None
    seed: int | None = None
    image: list[str] | None = None  # референсы как data:URL (для /images/edits)


@app.get("/health")
def health():
    return {"models": sorted(MODELS), "device": DEVICE}


def run(req: GenRequest, refs: list[Image.Image] | None):
    if req.model not in MODELS:
        raise HTTPException(404, f"модель «{req.model}» не настроена (есть: {', '.join(sorted(MODELS))})")
    kind, repo = MODELS[req.model]
    width, height = parse_size(req.size)
    n = max(1, min(req.n, 8))

    defaults = LCM_DEFAULTS if repo in _lcm_repos else KIND_DEFAULTS.get(kind, {})
    extra: dict = {}
    steps = req.steps if req.steps is not None else defaults.get("num_inference_steps")
    guidance = req.guidance if req.guidance is not None else defaults.get("guidance_scale")
    if steps is not None:
        extra["num_inference_steps"] = steps
    if guidance is not None:
        extra["guidance_scale"] = guidance

    def gen(pipe, **kw):
        # Задан seed — по генератору на вариант (seed, seed+1, ...), чтобы варианты различались
        if req.seed is not None:
            out = []
            for i in range(n):
                g = torch.Generator(device="cpu").manual_seed(req.seed + i)
                out += pipe(num_images_per_prompt=1, generator=g, **kw).images
            return out
        return pipe(num_images_per_prompt=n, **kw).images

    try:
        if kind == "edit":
            if not refs:
                raise HTTPException(400, "модели вида edit работают только с референсами (image: [...])")
            out = gen(load_pipeline(kind, repo), prompt=req.prompt, image=refs, **extra)
        elif kind == "photomaker":
            if not refs:
                raise HTTPException(400, "photomaker'у нужны фото лица как референсы (image: [...])")
            out = gen(load_pipeline(kind, repo), prompt=_with_trigger(req.prompt), input_id_images=refs, **extra)
        elif refs:
            out = gen(
                load_img2img(repo),
                prompt=req.prompt,
                image=refs[0],
                strength=IMG2IMG_STRENGTH,
                **extra,
            )
        else:
            out = gen(load_pipeline(kind, repo), prompt=req.prompt, width=width, height=height, **extra)
    except HTTPException:
        raise
    except Exception as err:  # ошибки diffusers отдаём текстом, а не голым 500
        raise HTTPException(500, f"{type(err).__name__}: {err}")

    return {"data": [{"b64_json": encode_png(img)} for img in out]}


@app.post("/v1/images/generations")
def generations(req: GenRequest):
    return run(req, refs=None)


@app.post("/v1/images/edits")
def edits(req: GenRequest):
    return run(req, refs=[decode_dataurl(u) for u in (req.image or [])])
