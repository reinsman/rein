#!/usr/bin/env python3
"""Local Hub → reind → native/A2A integration stack. Uses deterministic agents, no model calls."""
import argparse
import contextlib
import json
import os
import pathlib
import shlex
import signal
import sqlite3
import socket
import subprocess
import tempfile
import time
import urllib.error
import urllib.request
import uuid

ROOT = pathlib.Path(__file__).resolve().parents[1]
REIN = ROOT / 'target/debug/rein'
A2A = ROOT.parent / 'a2alinker/target/debug/a2alinker'
FIXTURE = ROOT.parent / 'a2alinker/crates/a2alinker/tests/fixtures/fake_agent.py'
HUB = pathlib.Path(os.environ.get('REIN_TEST_HUB_BINARY', '/tmp/reinhub-dev-console'))


def available_port():
    with socket.socket() as sock:
        sock.bind(('127.0.0.1', 0))
        return sock.getsockname()[1]


class Stack:
    def __init__(self, serve=False, insecure_skip_verify=False):
        self.serve = serve
        self.insecure_skip_verify = insecure_skip_verify
        self.temp = tempfile.TemporaryDirectory(prefix='rein-hub-integration-')
        self.directory = pathlib.Path(self.temp.name)
        self.env = {**os.environ, 'REIN_HOME': str(self.directory / 'daemon'),
                    'A2ALINKER_TEST_TRACE': str(self.directory / 'trace.jsonl')}
        self.processes = []
        self.logs = []
        self.http_port = int(os.environ.get('REIN_TEST_HTTP_PORT', available_port()))
        self.grpc_port = int(os.environ.get('REIN_TEST_GRPC_PORT', available_port()))
        self.a2a_port = int(os.environ.get('REIN_TEST_A2A_PORT', available_port()))
        self.http = f'http://127.0.0.1:{self.http_port}'
        self.grpc = f'https://localhost:{self.grpc_port}'

    def start_process(self, args, name):
        log = open(self.directory / f'{name}.log', 'w')
        self.logs.append(log)
        process = subprocess.Popen([str(arg) for arg in args], env=self.env, stdout=log, stderr=log, start_new_session=not self.serve)
        self.processes.append(process)
        return process

    def cli(self, *args):
        result = subprocess.run([str(REIN), *map(str, args)], env=self.env, capture_output=True, text=True, timeout=35)
        assert result.returncode == 0, f'{args}: {result.stderr}'
        return result.stdout

    def api(self, path, value=None):
        data = None if value is None else json.dumps(value).encode()
        request = urllib.request.Request(self.http + path, data=data, headers={'Content-Type': 'application/json'})
        with urllib.request.urlopen(request, timeout=10) as response:
            return json.load(response)

    def wait(self, function, description, timeout=25):
        deadline = time.monotonic() + timeout
        while time.monotonic() < deadline:
            try:
                result = function()
                if result:
                    return result
            except (OSError, urllib.error.URLError):
                pass
            time.sleep(.1)
        raise AssertionError(f'timed out: {description}; logs: {self.directory}')

    def wait_online(self):
        stable = None
        def check():
            nonlocal stable
            agents = self.api('/api/agents')['agents']
            if not agents or not all(a['agent'].get('disabled') or a['online'] for a in agents):
                stable = None
                return False
            stable = stable or time.monotonic()
            return time.monotonic() - stable >= .5
        self.wait(check, 'stable daemon connection')

    def start(self):
        assert REIN.exists() and (REIN.parent / 'reind').exists(), 'cargo build --bins in rein first'
        assert HUB.exists(), 'build reinhub: go build -o /tmp/reinhub-dev-console ./cmd/server'
        assert A2A.exists(), 'cargo build --bins in a2alinker first'
        hub_dir = self.directory / 'hub'
        config = self.directory / 'hub.toml'
        config.write_text(f'listen = "127.0.0.1:{self.http_port}"\ndirectory={json.dumps(str(hub_dir))}\n[grpc]\nlisten = "127.0.0.1:{self.grpc_port}"\n')
        self.hub_config = config
        self.hub_process = self.start_process([HUB, '-conf', config], 'hub')
        self.wait(lambda: self.api('/api/health'), 'Hub HTTP')
        if self.serve:
            self.start_process([REIN.parent / 'reind'], 'daemon-foreground')
            self.wait(lambda: (self.directory / 'daemon/reind.sock').exists(), 'daemon IPC')
        else:
            self.cli('daemon', 'start')
        self.ca = hub_dir / 'ca.pem'
        self.tls_args = ['--insecure-skip-verify'] if self.insecure_skip_verify else ['--ca', self.ca]
        prepared_bin = self.directory / 'prepared-bin'
        prepared_bin.mkdir()
        (prepared_bin / 'rein-fixture-pi').symlink_to(FIXTURE)
        for provider in ['codex', 'pi']:
            workspace = self.directory / provider
            workspace.mkdir()
            native_config = self.directory / f'{provider}-config'
            native_config.mkdir()
            launch = ['--executable', FIXTURE] if provider == 'codex' else [
                '--executable', 'rein-fixture-pi', '--prepare', f'export PATH={shlex.quote(str(prepared_bin))}:"$PATH"']
            prefix = ['up'] if provider == 'codex' else ['register', 'agent']
            self.cli(*prefix, provider, '--workspace', workspace, *launch,
                     '--native-config', native_config, '--hub', self.grpc, *self.tls_args)
        workspace = self.directory / 'a2a-workspace'
        workspace.mkdir()
        config_dir = self.directory / 'a2a-config'
        config_dir.mkdir()
        self.start_process([A2A, 'serve', '--name', 'test-pi', '--desc', 'deterministic integration agent',
                            '--agent', 'pi', '--workspace', workspace, '--executable', FIXTURE,
                            '--agent-config', config_dir, '--storage-dir', self.directory / 'a2a-storage',
                            '--listen', f'127.0.0.1:{self.a2a_port}'], 'a2a')
        self.wait(lambda: urllib.request.urlopen(f'http://127.0.0.1:{self.a2a_port}/.well-known/agent-card.json', timeout=1), 'A2A service')
        self.cli('up', 'a2a', '--name', 'a2a-pi', '--url', f'http://127.0.0.1:{self.a2a_port}', '--hub', self.grpc, *self.tls_args)
        self.wait(lambda: len(self.api('/api/agents')['agents']) == 3 and all(a['online'] for a in self.api('/api/agents')['agents']), 'registered agents online')
        self.agents = {a['agent']['name']: a['agent']['id'] for a in self.api('/api/agents')['agents']}
        # 两个并发的同名注册也必须指向相同 Agent，不在 Hub 留下幽灵副本。
        from concurrent.futures import ThreadPoolExecutor
        with ThreadPoolExecutor(max_workers=2) as executor:
            results = list(executor.map(lambda _: self.cli('register','agent','codex','--workspace',self.directory/'codex','--executable',FIXTURE,'--native-config',self.directory/'codex-config','--hub',self.grpc,*self.tls_args), range(2)))
        assert all(json.loads(result)['agent_id'] == self.agents['codex'] for result in results)
        assert len(self.api('/api/agents')['agents']) == 3
        self.wait_online()

        return self

    def submit(self, name, prompt, session=''):
        return self.api('/api/runs', {'request_id': str(uuid.uuid4()), 'agent_id': self.agents[name], 'session_id': session, 'prompt': prompt})['run']

    def state(self, run, states):
        def check():
            current = self.api('/api/runs/' + run['id'])['run']
            return current if current['state'] in states else None
        return self.wait(check, f'{run["id"]} → {states}')

    def events(self, run):
        return self.api(f'/api/runs/{run["id"]}/events?attempt_id={run["attemptId"]}&after=0')

    def verify(self):
        # 使用另一份有效 CA 必须失败，不能在 TLS 错误后自动退回跳过校验。
        wrong_dir = self.directory / 'other-hub'
        wrong_config = self.directory / 'other-hub.toml'
        wrong_config.write_text(f'listen="127.0.0.1:{available_port()}"\ndirectory={json.dumps(str(wrong_dir))}\n[grpc]\nlisten="127.0.0.1:{available_port()}"\n')
        other = self.start_process([HUB, '-conf', wrong_config], 'other-hub')
        self.wait(lambda: (wrong_dir / 'ca.pem').exists(), 'unrelated test CA')
        rejected = subprocess.run([str(REIN), 'register', 'agent', 'codex', '--workspace', str(self.directory/'codex'),
            '--executable', str(FIXTURE), '--native-config', str(self.directory/'codex-config'), '--hub', self.grpc,
            '--ca', str(wrong_dir/'ca.pem')], env=self.env, capture_output=True, text=True, timeout=35)
        assert rejected.returncode != 0 and 'certificate' in rejected.stderr.lower(), rejected.stderr
        other.terminate()
        other.wait(timeout=12)
        with sqlite3.connect(self.directory / 'daemon/reind.sqlite') as connection:
            mode = connection.execute("SELECT value FROM bridge_settings WHERE key='hub_insecure_skip_verify'").fetchone()[0]
        assert mode == str(self.insecure_skip_verify).lower(), mode
        print('TLS: unrelated CA rejected; explicit verification mode persisted', flush=True)
        sessions = {}
        for name in self.agents:
            run = self.submit(name, 'hello')
            done = self.state(run, ['RUN_STATE_COMPLETED', 'RUN_STATE_FAILED'])
            assert done['state'] == 'RUN_STATE_COMPLETED', (name, self.events(done))
            assert any(e.get('text', {}).get('text') == 'Hello 1' for e in self.events(done)), name
            followup = self.submit(name, 'again', done['sessionId'])
            done2 = self.state(followup, ['RUN_STATE_COMPLETED', 'RUN_STATE_FAILED'])
            assert done2['state'] == 'RUN_STATE_COMPLETED', (name, self.events(done2))
            assert any(e.get('text', {}).get('text') == 'Hello 2' for e in self.events(done2)), name
            sessions[name] = done2['sessionId']
            approval = self.submit(name, 'approval')
            waiting = self.state(approval, ['RUN_STATE_WAITING_INPUT', 'RUN_STATE_WAITING_APPROVAL', 'RUN_STATE_FAILED'])
            assert waiting['state'] != 'RUN_STATE_FAILED', (name, self.events(waiting))
            interaction = next(e['interaction'] for e in self.events(waiting) if 'interaction' in e)
            value = {'decision': 'accept'} if name == 'codex' else {'confirmed': True}
            self.api(f'/api/runs/{approval["id"]}/reply', {'command_id': str(uuid.uuid4()), 'attempt_id': waiting['attemptId'], 'interaction_id': interaction['interactionId'], 'response': value})
            done3 = self.state(approval, ['RUN_STATE_COMPLETED', 'RUN_STATE_FAILED'])
            assert done3['state'] == 'RUN_STATE_COMPLETED', (name, self.events(done3))
            slow = self.submit(name, 'slow')
            running = self.state(slow, ['RUN_STATE_RUNNING'])
            self.api(f'/api/runs/{slow["id"]}/cancel', {'command_id': str(uuid.uuid4()), 'attempt_id': running['attemptId']})
            cancelled = self.state(slow, ['RUN_STATE_CANCELLED', 'RUN_STATE_FAILED'])
            assert cancelled['state'] == 'RUN_STATE_CANCELLED', (name, self.events(cancelled))
            assert self.events(cancelled)[-1]['result']['executionStopped']
            failed = self.submit(name, 'fail')
            failure = self.state(failed, ['RUN_STATE_FAILED'])
            assert any(e.get('error') for e in self.events(failure)), name
            log = (self.directory / 'daemon/daemon.log').read_text()
            assert any(failed['id'] in line and 'run error' in line for line in log.splitlines()), name
            assert any(failed['id'] in line and 'RUN_STATE_FAILED' in line for line in log.splitlines()), name
            print(f'{name}: registration, execution, session resume, interaction, cancellation and failure logging passed', flush=True)
        self.cli('daemon', 'stop')
        self.cli('daemon', 'start')
        self.wait(lambda: all(a['online'] for a in self.api('/api/agents')['agents']), 'daemon reconnect')
        assert {a['agent']['name']:a['agent']['id'] for a in self.api('/api/agents')['agents']} == self.agents
        for name, session in sessions.items():
            run = self.submit(name, 'after daemon restart', session)
            done = self.state(run, ['RUN_STATE_COMPLETED', 'RUN_STATE_FAILED'])
            assert done['state'] == 'RUN_STATE_COMPLETED', self.events(done)
            assert any(e.get('text', {}).get('text') == 'Hello 3' for e in self.events(done)), name
        print('Daemon restart: stable registrations and native/A2A session mappings passed', flush=True)
        held = self.submit('codex', 'approval')
        waiting = self.state(held, ['RUN_STATE_WAITING_APPROVAL'])
        interaction = next(e['interaction'] for e in self.events(waiting) if 'interaction' in e)
        # Hub 崩溃后仍从已持久化状态对账；原生执行保持在 daemon 中，不重新启动。
        self.hub_process.kill()
        self.hub_process.wait()
        self.hub_process = self.start_process([HUB, '-conf', self.hub_config], 'hub-restarted')
        self.wait(lambda: all(a['online'] for a in self.api('/api/agents')['agents']), 'Hub restart reconciliation')
        self.api(f'/api/runs/{held["id"]}/reply', {'command_id':str(uuid.uuid4()),'attempt_id':waiting['attemptId'],'interaction_id':interaction['interactionId'],'response':{'decision':'accept'}})
        assert self.state(held, ['RUN_STATE_COMPLETED','RUN_STATE_FAILED'])['state'] == 'RUN_STATE_COMPLETED'
        print('Hub restart: active interaction reconciliation and event replay passed', flush=True)

        def up(name):
            args = ['up', name] if name != 'a2a-pi' else ['up', 'a2a', '--name', name]
            result = json.loads(self.cli(*args))
            assert result['agent_id'] == self.agents[name]
            self.wait_online()

        for name in self.agents:
            active = self.state(self.submit(name, 'slow'), ['RUN_STATE_RUNNING'])
            rejected = subprocess.run([str(REIN), 'down', name], env=self.env, capture_output=True, text=True, timeout=35)
            assert rejected.returncode != 0 and 'unfinished' in rejected.stderr, rejected.stderr
            self.api(f'/api/runs/{active["id"]}/cancel', {'command_id':str(uuid.uuid4()),'attempt_id':active['attemptId']})
            self.state(active, ['RUN_STATE_CANCELLED'])
            result = json.loads(self.cli('down', name))
            assert result['state'] == 'down' and result['agent_id'] == self.agents[name]
            assert json.loads(self.cli('down', self.agents[name]))['state'] == 'down'
            listing = next(a for a in json.loads(self.cli('ls')) if a['id'] == self.agents[name])
            assert listing['disabled']
            remote = next(a for a in self.api('/api/agents')['agents'] if a['agent']['id'] == self.agents[name])
            assert remote['agent']['disabled'] and not remote['online']
            history = self.api('/api/agents/' + self.agents[name] + '/history?session_id=' + sessions[name])
            assert history['runs'], name
            try:
                self.submit(name, 'must not execute while down')
            except urllib.error.HTTPError as error:
                assert error.code == 409
            else:
                raise AssertionError('down Agent accepted a Run')
            up(name)
            resumed = self.state(self.submit(name, 'after down/up', sessions[name]), ['RUN_STATE_COMPLETED','RUN_STATE_FAILED'])
            assert resumed['state'] == 'RUN_STATE_COMPLETED', self.events(resumed)
            assert any(e.get('text',{}).get('text') == 'Hello 4' for e in self.events(resumed)), name
            print(f'{name}: up/down, stable identity, busy rejection, disabled scheduling and retained session passed', flush=True)

        self.cli('down', 'pi')
        self.cli('daemon', 'stop')
        self.cli('daemon', 'start')
        self.wait_online()
        assert next(a for a in self.api('/api/agents')['agents'] if a['agent']['id'] == self.agents['pi'])['agent']['disabled']
        up('pi')
        self.hub_process.kill()
        self.hub_process.wait()
        pending = subprocess.run([str(REIN), 'down', 'pi'], env=self.env, capture_output=True, text=True, timeout=35)
        assert pending.returncode != 0 and 'not confirmed' in pending.stderr, pending.stderr
        with sqlite3.connect(self.directory/'daemon/reind.sqlite') as connection:
            assert connection.execute("SELECT completed FROM agent_removals WHERE name='pi'").fetchone()[0] == 0
        self.cli('daemon', 'stop')
        self.cli('daemon', 'start')
        self.hub_process = self.start_process([HUB,'-conf',self.hub_config], 'hub-after-pending-down')
        self.wait(lambda: self.api('/api/health'), 'Hub after pending down')
        self.wait_online()
        remote = next(a for a in self.api('/api/agents')['agents'] if a['agent']['id'] == self.agents['pi'])
        assert remote['agent']['disabled'] and not remote['online']
        with sqlite3.connect(self.directory/'daemon/reind.sqlite') as connection:
            assert connection.execute("SELECT completed FROM agent_removals WHERE name='pi'").fetchone()[0] == 1
        up('pi')
        done = self.state(self.submit('pi', 'after pending down recovery', sessions['pi']), ['RUN_STATE_COMPLETED','RUN_STATE_FAILED'])
        assert done['state'] == 'RUN_STATE_COMPLETED' and any(e.get('text',{}).get('text') == 'Hello 5' for e in self.events(done)), self.events(done)
        print('Availability recovery: down survives restart; pending down retries after Hub outage without republishing the Agent', flush=True)


    def close(self):
        if REIN.exists():
            with contextlib.suppress(Exception):
                self.cli('daemon', 'stop')
        for process in reversed(self.processes):
            if process.poll() is None:
                if self.serve:
                    process.terminate()
                else:
                    os.killpg(process.pid, signal.SIGTERM)
                try:
                    process.wait(timeout=12)
                except subprocess.TimeoutExpired:
                    if self.serve:
                        process.kill()
                    else:
                        os.killpg(process.pid, signal.SIGKILL)
                    process.wait()
        for log in self.logs:
            log.close()
        if os.environ.get('REIN_TEST_KEEP_LOGS'):
            self.temp._finalizer.detach()
            print('Integration logs:', self.directory, flush=True)
        else:
            self.temp.cleanup()


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('--serve', action='store_true')
    parser.add_argument('--insecure-skip-verify', action='store_true')
    args = parser.parse_args()
    stack = Stack(serve=args.serve, insecure_skip_verify=args.insecure_skip_verify)
    signal.signal(signal.SIGTERM, lambda *_: (_ for _ in ()).throw(SystemExit(0)))
    try:
        stack.start()
        if args.serve:
            print(json.dumps({'ready': True, 'http': stack.http}), flush=True)
            while True:
                time.sleep(1)
        else:
            stack.verify()
    finally:
        stack.close()
