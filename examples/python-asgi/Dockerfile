FROM python:3.13-slim
WORKDIR /app
COPY sdk/python ./sdk/python
RUN pip install --no-cache-dir ./sdk/python
COPY examples/python-asgi ./examples/python-asgi
RUN pip install --no-cache-dir -r ./examples/python-asgi/requirements.txt
WORKDIR /app/examples/python-asgi
ENV PYTHONUNBUFFERED=1
CMD ["sh", "-c", "uvicorn app:app --host 0.0.0.0 --port ${PORT:-8080}"]
