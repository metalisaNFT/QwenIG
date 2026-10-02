"""Start a loopback-only demo with an ephemeral key. No secrets written to disk."""
import os
import secrets
import sys
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import uvicorn
from backend.app import create_app
from backend.runner import DemoRunner

if __name__ == '__main__':
    token = os.environ.get('ZERO_API_TOKEN') or secrets.token_urlsafe(32)
    print('\nStudio Zero procedural demo (not AI generation)\nService: http://127.0.0.1:8000\nAccess key: ' + token + '\n', flush=True)
    uvicorn.run(create_app(DemoRunner(), token), host='127.0.0.1', port=8000)
