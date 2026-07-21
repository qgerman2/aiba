from pathlib import Path

from fastapi import FastAPI, HTTPException
from fastapi.responses import FileResponse, HTMLResponse
from starlette.responses import Response
from fastapi.staticfiles import StaticFiles


BASE_DIR = Path(__file__).resolve().parent
DIST_DIR = BASE_DIR / "dist"
ASSETS_DIR = DIST_DIR / "assets"

app = FastAPI(title="FastAPI React Vite")


if ASSETS_DIR.exists():
    app.mount("/assets", StaticFiles(directory=ASSETS_DIR), name="assets")


@app.get("/{path:path}", response_class=HTMLResponse, response_model=None)
def serve_react_app(path: str) -> Response:
    if path == "api" or path.startswith("api/"):
        raise HTTPException(status_code=404)

    requested_file = DIST_DIR / path
    if requested_file.is_file():
        return FileResponse(requested_file)

    index_file = DIST_DIR / "index.html"
    if index_file.exists():
        return FileResponse(index_file)

    return HTMLResponse(
        """
        <!doctype html>
        <html lang="en">
          <head><title>Build required</title></head>
          <body>
            <h1>React build not found</h1>
            <p>Run <code>npm install</code> and <code>npm run build</code>, then restart FastAPI.</p>
          </body>
        </html>
        """,
        status_code=503,
    )
