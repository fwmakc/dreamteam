# Тонкий facade над diffusers (app.py). CPU-вариант по умолчанию — лёгкие колёса
# torch без CUDA; для GPU-машин собирайте с TORCH_INDEX=https://pypi.org/simple
# (это делает compose для профилей image/edit автоматически).
FROM python:3.12-slim

ARG TORCH_INDEX=https://download.pytorch.org/whl/cpu

WORKDIR /srv
COPY requirements.txt .
RUN pip install --no-cache-dir torch --index-url ${TORCH_INDEX} \
 && pip install --no-cache-dir -r requirements.txt

COPY app.py .
EXPOSE 8100
CMD ["uvicorn", "app:app", "--host", "0.0.0.0", "--port", "8100"]
