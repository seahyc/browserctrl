import importlib.util
import io
import json
import os
from pathlib import Path
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location('client', ROOT / 'python/chrome_cdp/__init__.py')
client = importlib.util.module_from_spec(spec)
spec.loader.exec_module(client)


class FakeProcess:
    def __init__(self, replies):
        reader, writer = os.pipe()
        os.write(writer, b''.join(json.dumps(row).encode() + b'\n' for row in replies))
        self.writer = writer
        self.stdout = os.fdopen(reader, 'rb', buffering=0)
        self.stdin = io.BytesIO()
        self.pid = 123

    def poll(self):
        return 0

    def finish(self):
        os.close(self.writer)
        self.stdout.close()
        self.stdin.close()


class ClientTests(unittest.TestCase):
    def test_explicit_selector_required(self):
        for kwargs in [{}, {'browser': 'dia', 'port': 9223}]:
            with self.assertRaises(ValueError):
                client.ChromeCDP(**kwargs)

    def test_reuses_process_and_consumes_buffered_responses(self):
        fake = FakeProcess([{'id': 1, 'result': {'ok': True}}, {'id': 2, 'result': {'targetId': 'test'}}])
        try:
            with patch.object(client.subprocess, 'Popen', return_value=fake) as spawn:
                sdk = client.ChromeCDP(browser='dia')
                self.assertEqual(sdk.new_tab(), 'test')
                self.assertEqual(spawn.call_count, 1)
                rows = [json.loads(row) for row in fake.stdin.getvalue().splitlines()]
                self.assertEqual([row['op'] for row in rows], ['health', 'new_tab'])
                sdk.close()
        finally:
            fake.finish()

    def test_timeout_does_not_replay(self):
        fake = FakeProcess([{'id': 1, 'result': {'ok': True}}])
        try:
            with patch.object(client.subprocess, 'Popen', return_value=fake):
                sdk = client.ChromeCDP(browser='dia')
                with patch.object(client.select, 'select', return_value=([], [], [])):
                    with self.assertRaisesRegex(client.CDPError, 'outcome uncertain'):
                        sdk.send('test', 'Input.insertText', text='hello')
                rows = [json.loads(row) for row in fake.stdin.getvalue().splitlines()]
                self.assertEqual(sum(row['method'] == 'Input.insertText' for row in rows), 1)
                self.assertTrue(sdk._closed)
        finally:
            fake.finish()

    def test_initialization_allowance_keeps_the_requested_action_timeout(self):
        fake = FakeProcess([{'id': 1, 'result': {'ok': True}}])
        try:
            with patch.object(client.subprocess, 'Popen', return_value=fake):
                with patch.object(client.select, 'select', wraps=client.select.select) as waits:
                    sdk = client.ChromeCDP(browser='dia')
                    self.assertGreater(waits.call_args.args[3], 330)
                os.write(fake.writer, json.dumps({'id': 2, 'result': {}}).encode() + b'\n')
                with patch.object(client.select, 'select', wraps=client.select.select) as waits:
                    sdk.send('test', 'Runtime.evaluate', timeout=0.1, expression='1')
                    self.assertGreater(waits.call_args.args[3], 60)
                    self.assertLess(waits.call_args.args[3], 66)
                rows = [json.loads(row) for row in fake.stdin.getvalue().splitlines()]
                self.assertEqual(rows[-1]['timeout_ms'], 100)
                self.assertEqual(len(rows), 2)
                sdk.close()
        finally:
            fake.finish()

    def test_error_is_not_retried(self):
        fake = FakeProcess([{'id': 1, 'result': {'ok': True}}, {'id': 2, 'error': 'claimed by another owner'}])
        try:
            with patch.object(client.subprocess, 'Popen', return_value=fake):
                sdk = client.ChromeCDP(browser='dia')
                with self.assertRaisesRegex(client.CDPError, 'claimed'):
                    sdk.attach('test')
                self.assertEqual(len(fake.stdin.getvalue().splitlines()), 2)
                sdk.close()
        finally:
            fake.finish()


if __name__ == '__main__':
    unittest.main()
