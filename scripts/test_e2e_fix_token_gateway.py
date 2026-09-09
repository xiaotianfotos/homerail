import importlib.util
import json
from pathlib import Path
import tempfile
import threading
import unittest
import urllib.request
import urllib.error
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

spec = importlib.util.spec_from_file_location("token_gateway", Path(__file__).with_name("e2e-fix-token-gateway.py"))
gateway = importlib.util.module_from_spec(spec)
spec.loader.exec_module(gateway)


class Tokenizer:
    def __init__(self):
        self.calls = []
        self.count = 30

    def apply_chat_template(self, messages, **kwargs):
        self.calls.append((messages, kwargs))
        return list(range(self.count))


class Tests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.tokenizer = Tokenizer()
        self.requests = []
        self.wire_response = b'{"usage":{"prompt_tokens":30,"completion_tokens":2}}'
        test = self

        class Upstream(BaseHTTPRequestHandler):
            def log_message(self, *args):
                pass

            def do_POST(self):
                test.requests.append((self.rfile.read(int(self.headers['Content-Length'])), self.headers.get('Authorization')))
                self.send_response(200)
                self.send_header('Content-Type', 'application/json')
                self.end_headers()
                self.wfile.write(test.wire_response)

        self.upstream = ThreadingHTTPServer(('127.0.0.1', 0), Upstream)
        self.start(self.upstream)
        self.policy = {'request_format':'freetoken-qwen-text-v1', 'model':'qwen', 'context_window':65600, 'min_output_tokens':65536,
                       'max_output_tokens':65536, 'reasoning_efforts':['low','medium','xhigh'],
                       'upstream_url':f'http://127.0.0.1:{self.upstream.server_port}/v1'}
        self.server = gateway.Gateway(('127.0.0.1',0), self.policy, self.tokenizer,
                                      self.temp.name, 'gateway-secret', 'upstream-secret')
        self.start(self.server)
        self.base = f'http://127.0.0.1:{self.server.server_port}/v1'
        self.body = {'model':'qwen','messages':[{'role':'system','content':'审查规则'}, {'role':'user','content':'fix'}],
                     'tools':[{'type':'function','function':{'name':'handoff','parameters':{'type':'object'}}}],
                     'reasoning_effort':'low','max_tokens':65536,'stream':True}

    def start(self, server):
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        def stop():
            server.shutdown(); server.server_close(); thread.join()
        self.addCleanup(stop)

    def request(self, body=None, key='gateway-secret', path='/chat/completions'):
        raw = json.dumps(body).encode() if body is not None else None
        req = urllib.request.Request(self.base + path, data=raw,
                                     headers={'Authorization':'Bearer '+key, 'Content-Type':'application/json'})
        try:
            with urllib.request.urlopen(req, timeout=5) as response:
                return response.status, response.read()
        except urllib.error.HTTPError as error:
            return error.code, error.read()

    def test_complete_serialized_request_is_counted_and_forwarded_unchanged(self):
        self.wire_response = b'data: {"choices":[]}\n\ndata: [DONE]\n\n'
        status, response = self.request(self.body)
        self.assertEqual(status,200); self.assertEqual(response,self.wire_response)
        self.assertEqual(json.loads(self.requests[0][0]),self.body)
        self.assertEqual(self.requests[0][1],'Bearer upstream-secret')
        messages, kwargs = self.tokenizer.calls[0]
        self.assertEqual(messages,self.body['messages'])
        self.assertEqual(kwargs,{'tools':self.body['tools'],'tokenize':True,'add_generation_prompt':True,'reasoning_effort':'low'})
        records=(Path(self.temp.name)/'requests.jsonl').read_text()
        self.assertNotIn('secret',records);self.assertNotIn('审查规则',records)

    def test_server_tool_and_message_normalization_is_counted_without_modifying_wire(self):
        self.body['tools'][0]['function']['strict'] = False
        self.body['messages'] += [{'role':'assistant','content':None,'tool_calls':[
            {'id':'call','type':'function','function':{'name':'handoff','arguments':'{"ok":true}'}}]},
            {'role':'tool','tool_call_id':'call','content':[{'type':'text','text':'accepted'}]}]
        self.assertEqual(self.request(self.body)[0],200)
        messages, kwargs=self.tokenizer.calls[0]
        self.assertNotIn('strict',kwargs['tools'][0]['function'])
        self.assertEqual(messages[-2]['tool_calls'][0]['function']['arguments'],{'ok':True})
        self.assertEqual(messages[-1]['content'],'accepted')
        self.assertEqual(json.loads(self.requests[0][0]),self.body)

    def test_output_reserve_rejected_before_any_generation_request(self):
        self.tokenizer.count=65
        status,body=self.request(self.body)
        self.assertEqual(status,400);self.assertEqual(json.loads(body)['error']['code'],'context_length_exceeded')
        self.assertEqual(self.requests,[])
        record=json.loads((Path(self.temp.name)/'requests.jsonl').read_text())
        self.assertEqual(record['upstream_requests'],0)
        self.assertEqual(record['input_tokens'],65)
        self.assertEqual(record['output_reserve'],65536)

    def test_exact_boundary_is_admitted(self):
        self.tokenizer.count=64
        self.assertEqual(self.request(self.body)[0],200)
        self.assertEqual(len(self.requests),1)

    def test_authentication_and_frozen_policy_handshake(self):
        self.assertEqual(self.request(self.body,key='wrong')[0],401)
        self.assertEqual(self.tokenizer.calls,[])
        status,body=self.request(path='/context-policy')
        self.assertEqual(status,200);p=json.loads(body)
        self.assertEqual(p['policy_sha256'],self.server.policy_sha256)
        self.assertNotIn('upstream_url',p)
        self.assertEqual(self.requests,[])

    def test_model_discovery_exposes_only_the_admitted_model(self):
        self.assertEqual(self.request(path='/models',key='wrong')[0],401)
        status,body=self.request(path='/models')
        self.assertEqual(status,200)
        self.assertEqual(json.loads(body),{'object':'list','data':[
            {'id':'qwen','object':'model','owned_by':'local','context_length':65600}]})
        self.assertEqual(self.requests,[])
        self.assertEqual(self.tokenizer.calls,[])

    def test_unsupported_shapes_and_reserves_do_not_reach_tokenizer(self):
        for patch in [{'model':'different'},{'max_tokens':False},{'max_tokens':8192},
                      {'max_completion_tokens':65536},{'chat_template_kwargs':{'enable_thinking':False}},
                      {'messages':[{'role':'user','content':[{'type':'image_url','image_url':{}}]}]}]:
            with self.subTest(patch=patch):
                self.assertEqual(self.request({**self.body,**patch})[0],400)
        self.assertEqual(self.tokenizer.calls,[]);self.assertEqual(self.requests,[])

    def test_evidence_directory_cannot_be_rebound_to_another_policy(self):
        with self.assertRaisesRegex(ValueError,'another policy'):
            gateway.Gateway(('127.0.0.1',0),{**self.policy,'model':'another'},self.tokenizer,self.temp.name,'secret')


if __name__=='__main__':
    unittest.main()
