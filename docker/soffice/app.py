"""
Тонкий мост над LibreOffice для тула docs: принимает файл и целевой формат,
отдаёт сконвертированный файл. Один запрос — один вызов
`soffice --headless --convert-to`, у каждого вызова свой профиль пользователя
(-env:UserInstallation), поэтому запросы не дерутся за общий ~/.config.

POST /convert   multipart: file=<документ>, target=<расширение: pdf|docx|xlsx|odt|...>
Ответ:          бинарный файл сконвертированного документа.
GET  /health    {"service": "soffice"}
"""

import re
import shutil
import subprocess
import tempfile
import threading
from pathlib import Path

from fastapi import FastAPI, File, Form, HTTPException, UploadFile
from fastapi.responses import FileResponse

# Разрешённые цели конвертации — расширения, которые LibreOffice умеет писать.
# Всё остальное отклоняем сразу с перечнем, а не растерянным stderr-ом.
TARGETS = {
    "pdf", "txt", "html", "csv", "rtf",
    "docx", "xlsx", "pptx",
    "odt", "ods", "odp",
    "doc", "xls", "ppt",
}

TIMEOUT = int(__import__("os").environ.get("SOFFICE_TIMEOUT", "120"))

app = FastAPI()

# soffice прожорлив: два десятка параллельных конвертов положат контейнер по
# памяти. Сериализуем — очередь на конвертацию лучше OOM-kill посреди работы.
lock = threading.Lock()


@app.get("/health")
def health() -> dict:
    return {"service": "soffice"}


@app.post("/convert")
async def convert(file: UploadFile = File(...), target: str = Form(...)) -> FileResponse:
    target = target.strip().lower()
    if not re.fullmatch(r"[a-z0-9]{2,5}", target) or target not in TARGETS:
        raise HTTPException(422, f"цель «{target}» не поддерживается — есть: {', '.join(sorted(TARGETS))}")

    work = Path(tempfile.mkdtemp(prefix="dt-convert-"))
    try:
        src = work / (Path(file.filename or "input").name or "input")
        with src.open("wb") as f:
            shutil.copyfileobj(file.file, f)

        outdir = work / "out"
        outdir.mkdir()
        profile = f"file://{(work / 'profile').as_posix()}"
        cmd = [
            "soffice", "--headless", "--norestore",
            f"-env:UserInstallation={profile}",
            "--convert-to", target, "--outdir", str(outdir), str(src),
        ]
        with lock:
            try:
                proc = subprocess.run(cmd, capture_output=True, text=True, timeout=TIMEOUT)
            except subprocess.TimeoutExpired:
                raise HTTPException(504, f"конвертация в {target} не уложилась в {TIMEOUT} с")

        produced = list(outdir.iterdir())
        if proc.returncode != 0 or not produced:
            tail = (proc.stderr or proc.stdout or "").strip()[-500:]
            raise HTTPException(422, f"LibreOffice не смог конвертировать в {target}: {tail or 'без диагностики'}")

        result = produced[0]
        return FileResponse(
            result,
            media_type="application/octet-stream",
            filename=src.stem + "." + target,
        )
    finally:
        shutil.rmtree(work, ignore_errors=True)
