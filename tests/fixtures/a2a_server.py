#!/usr/bin/env python3
"""Deterministic A2A 1.0 JSON-RPC fixture, with context resume and task cancellation."""
import json
import sys
import uuid
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

COUNTS = {}
TASKS = {}


class Handler(BaseHTTPRequestHandler):
    def log_message(self, *args):
        pass

    def send(self, body):
        data = json.dumps(body).encode()
        self.send_response(200)
        self.send_header('Content-Type', 'application/json')
        self.send_header('Content-Length', str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def do_GET(self):
        self.send({'name': 'Remote fixture', 'description': 'Test A2A', 'version': '1',
                   'supportedInterfaces': [{'url': f'http://127.0.0.1:{self.server.server_port}/rpc',
                                            'protocolBinding': 'JSONRPC', 'protocolVersion': '1.0'}],
                   'capabilities': {}, 'defaultInputModes': ['text/plain'],
                   'defaultOutputModes': ['text/plain'], 'skills': []})

    def do_POST(self):
        request = json.loads(self.rfile.read(int(self.headers['Content-Length'])))
        params = request['params']
        method = request['method']
        if method == 'SendMessage':
            message = params['message']
            context = message.get('contextId') or str(uuid.uuid4())
            text = message['parts'][0]['text']
            COUNTS[context] = COUNTS.get(context, 0) + 1
            if text == 'slow':
                task_id = str(uuid.uuid4())
                TASKS[task_id] = {'id': task_id, 'contextId': context,
                                  'status': {'state': 'TASK_STATE_WORKING'}}
                result = {'task': TASKS[task_id]}
            else:
                result = {'message': {'messageId': str(uuid.uuid4()), 'contextId': context,
                                      'role': 'ROLE_AGENT',
                                      'parts': [{'text': f'Remote {COUNTS[context]}'}]}}
        else:
            task = TASKS[params['id']]
            if method == 'CancelTask':
                task['status']['state'] = 'TASK_STATE_CANCELED'
            result = task
        self.send({'jsonrpc': '2.0', 'id': request['id'], 'result': result})


if __name__ == '__main__':
    server = ThreadingHTTPServer(('127.0.0.1', int(sys.argv[1]) if len(sys.argv) > 1 else 0), Handler)
    print(f'http://127.0.0.1:{server.server_port}', flush=True)
    server.serve_forever()
