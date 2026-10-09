import logging
import os

import uvicorn

from .app import create_app
from .config import Settings

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(name)s %(levelname)s %(message)s")
settings = Settings()
# 기본은 이 컴퓨터에서만 접속. 컨테이너(compose)는 HOST=0.0.0.0 을 준다.
uvicorn.run(create_app(settings), host=os.environ.get("HOST") or "127.0.0.1", port=settings.port)
