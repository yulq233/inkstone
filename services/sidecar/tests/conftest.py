"""测试夹具。

约定：每个测试自己造 Settings，不读真实环境变量——
否则 CI 上少一个变量就会连锁失败，且失败原因和被测逻辑无关。
"""

from __future__ import annotations

import os
import secrets
from collections.abc import Iterator
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from inkstone.app import create_app
from inkstone.config import Settings

TOKEN = secrets.token_hex(32)


@pytest.fixture()
def token() -> str:
    return TOKEN


@pytest.fixture()
def settings(tmp_path: Path) -> Settings:
    log_dir = tmp_path / "logs"
    log_dir.mkdir(parents=True, exist_ok=True)
    return Settings(
        host="127.0.0.1",
        token=TOKEN,
        home=tmp_path,
        log_dir=log_dir,
        parent_pid=os.getpid(),
    )


@pytest.fixture()
def client(settings: Settings) -> Iterator[TestClient]:
    with TestClient(create_app(settings)) as test_client:
        yield test_client


@pytest.fixture()
def auth_headers() -> dict[str, str]:
    return {"X-Inkstone-Token": TOKEN}


@pytest.fixture()
def parent_dir(tmp_path: Path) -> Path:
    """作品存放目录。

    刻意带中文与空格 —— 这是 Windows 上最容易出编码问题的一类路径，
    如果测试全用 ASCII 临时目录，真实用户的书名一旦是中文就炸在最后一步。
    """
    directory = tmp_path / "我的 作品库"
    directory.mkdir(parents=True, exist_ok=True)
    return directory


@pytest.fixture()
def work(client: TestClient, auth_headers: dict[str, str], parent_dir: Path) -> dict:
    """建好一部作品并返回它的 summary。"""
    res = client.post(
        "/api/v1/works",
        headers=auth_headers,
        json={
            "parentDir": str(parent_dir),
            "title": "我的小说",
            "author": "小方同学",
            "genre": "玄幻",
            "wordGoal": 1000000,
        },
    )
    assert res.status_code == 201, res.text
    return res.json()["work"]


@pytest.fixture()
def work_root(work: dict) -> Path:
    return Path(work["rootPath"])
