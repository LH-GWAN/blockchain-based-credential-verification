import logging

import uvicorn

from .app import create_app
from .config import Settings

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(name)s %(levelname)s %(message)s")
settings = Settings()
uvicorn.run(create_app(settings), host="0.0.0.0", port=settings.port)
