"""Synchronous persistent browserctrl client. Add this package's parent to PYTHONPATH.

One Node sidecar per client, one shared daemon per explicitly selected browser.
A failed request is never retried. Inspect or reconnect explicitly after errors.
"""

import json
import os
import select
import subprocess
import threading
from pathlib import Path


class CDPError(RuntimeError):
    pass


class ChromeCDP:
    def __init__(self, *, browser=None, port=None, timeout=30, env=None):
        if bool(browser) == bool(port):
            raise ValueError("Select exactly one browser or port")
        root = Path(__file__).resolve().parents[2]
        selector = ["--browser", browser] if browser else ["--port", str(port)]
        self.timeout = timeout
        self._lock = threading.Lock()
        self._id = 0
        self._closed = False
        self.process = subprocess.Popen(
            ["node", str(root / "bin/stdio.mjs"), *selector],
            stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL,
            bufsize=0, env={**os.environ, **(env or {})},
        )
        self._buffer = b""
        try:
            self.health()
        except Exception:
            self.close()
            raise

    def request(self, op, *, target=None, method=None, params=None, timeout=None):
        """Send once; any disconnect/timeout leaves outcome uncertain, never replayed."""
        import time
        with self._lock:
            if self._closed:
                raise CDPError("Client closed; create a new connection and observe before acting")
            self._id += 1
            duration = self.timeout if timeout is None else timeout
            message = {"id": self._id, "op": op, "target": target, "method": method,
                       "params": params or {}, "timeout_ms": int(duration * 1000)}
            try:
                payload = memoryview(json.dumps(message).encode() + b"\n")
                while payload:
                    count = self.process.stdin.write(payload)
                    if not count:
                        raise OSError("Pipe closed")
                    payload = payload[count:]
                wait_duration = max(duration, 31) if op in ("health", "reconnect") else duration
                if op == "send":
                    wait_duration += 60
                if self._id == 1 or op == "reconnect":
                    wait_duration += 305
                deadline = time.monotonic() + wait_duration + 5
                while b"\n" not in self._buffer:
                    remaining = deadline - time.monotonic()
                    if remaining <= 0 or not select.select([self.process.stdout], [], [], remaining)[0]:
                        self.close()
                        raise CDPError("CDP request timed out; outcome uncertain. Observe before retrying any action")
                    chunk = os.read(self.process.stdout.fileno(), 65536)
                    if not chunk:
                        self.close()
                        raise CDPError("CDP disconnected; check explicit browser/port and run cdp doctor. No replay")
                    self._buffer += chunk
                line, self._buffer = self._buffer.split(b"\n", 1)
                response = json.loads(line)
                if response.get("id") != self._id:
                    self.close()
                    raise CDPError("CDP response mismatch; outcome uncertain. No replay")
            except (OSError, ValueError) as error:
                self.close()
                raise CDPError("CDP transport failed; outcome uncertain. No replay") from error
            if "error" in response:
                raise CDPError(response["error"])
            return response["result"]

    def health(self):
        return self.request("health")

    def reconnect(self):
        """Reconnect for future observations; never replay an earlier request."""
        return self.request("reconnect")

    def new_tab(self, url="about:blank"):
        return self.request("new_tab", params={"url": url})["targetId"]

    def attach(self, tab):
        return self.request("attach", params={"tab": tab})["targetId"]

    def send(self, target, method, *, timeout=None, **params):
        return self.request("send", target=target, method=method, params=params, timeout=timeout)

    def release(self, target):
        return self.request("release", target=target)

    def close_tab(self, target):
        return self.request("close_tab", target=target)

    def close(self):
        if self._closed:
            return
        self._closed = True
        if self.process.poll() is None:
            self.process.stdin.close()
            try:
                self.process.wait(timeout=3)
            except subprocess.TimeoutExpired:
                self.process.kill()
                self.process.wait()
        self.process.stdout.close()

    def __enter__(self):
        return self

    def __exit__(self, *_args):
        self.close()
