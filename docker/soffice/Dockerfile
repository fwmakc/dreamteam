# Мост LibreOffice для тула docs: writer/calc/impress + шрифты с кириллицей
# (DejaVu и Liberation — чтобы pdf не превращал русские буквы в квадраты).
FROM python:3.12-slim

RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      libreoffice-writer libreoffice-calc libreoffice-impress \
      fonts-dejavu fonts-liberation \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /srv
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY app.py .
EXPOSE 8200
CMD ["uvicorn", "app:app", "--host", "0.0.0.0", "--port", "8200"]
