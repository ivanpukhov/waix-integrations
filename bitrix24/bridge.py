"""Bitrix24 ONCRMDEALADD → durable outbox → WAIX API v1. Python 3.10+, stdlib only.
Run behind an HTTPS reverse proxy. No messages are sent until a worker is started.
"""
from __future__ import annotations
import argparse
import http.client
import hashlib
import hmac
import json
import os
import re
import sqlite3
import time
import urllib.error
import urllib.parse
import urllib.request
import uuid
from dataclasses import dataclass
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

UUID = re.compile(r'[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}', re.I)

class BridgeError(Exception):
    def __init__(self, code, status=400, retry_after=None):
        super().__init__(code)
        self.code, self.status, self.retry_after = code, status, retry_after

@dataclass(frozen=True, repr=False)
class Config:
    portal: str
    member_id: str
    application_token: str
    rest_base: str
    waix_key: str
    connection_id: str
    template: str
    consent_field: str
    language: str = 'ru'
    def __post_init__(self):
        if not re.fullmatch(r'[a-z0-9][a-z0-9.-]+\.[a-z]{2,}', self.portal): raise ValueError('Invalid configured portal host')
        u = urllib.parse.urlsplit(self.rest_base)
        if u.scheme != 'https' or u.netloc != self.portal or u.username or u.password or u.query or u.fragment or not re.fullmatch(r'/rest/[0-9]+/[A-Za-z0-9]+/', u.path): raise ValueError('REST base must be the HTTPS incoming webhook URL of the configured portal')
        if not self.member_id or not self.application_token or not self.waix_key or any(c in self.waix_key for c in '\r\n'): raise ValueError('Required credentials are missing')
        if not UUID.fullmatch(self.connection_id): raise ValueError('connection_id must be a UUID')
        if not re.fullmatch(r'[a-z0-9_]{1,512}', self.template): raise ValueError('Invalid approved template name')
        if not re.fullmatch(r'UF_CRM_[A-Z0-9_]+', self.consent_field): raise ValueError('Set a dedicated contact consent field')
        if not re.fullmatch(r'[a-z]{2,3}(?:_[A-Z]{2})?', self.language): raise ValueError('Invalid template language')
    @classmethod
    def from_env(cls):
        return cls(**{field: os.environ['WAIX_BRIDGE_' + field.upper()] for field in ('portal','member_id','application_token','rest_base','waix_key','connection_id','template','consent_field')}, language=os.environ.get('WAIX_BRIDGE_LANGUAGE','ru'))

class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, *args, **kwargs): return None

def http_json(url, body, headers=None):
    """Only called with configured hosts; neither URLs nor secrets enter errors/logs."""
    request = urllib.request.Request(url, data=json.dumps(body, ensure_ascii=False, allow_nan=False).encode(), method='POST', headers={'Content-Type':'application/json','Accept':'application/json', **(headers or {})})
    try:
        response = urllib.request.build_opener(NoRedirect()).open(request, timeout=20)
    except urllib.error.HTTPError as error:
        response = error
    except (OSError, urllib.error.URLError, http.client.HTTPException):
        raise BridgeError('UPSTREAM_UNAVAILABLE', 503) from None
    with response:
        try: raw = response.read(1024 * 1024 + 1)
        except (OSError, http.client.HTTPException): raise BridgeError('UPSTREAM_UNAVAILABLE', 503) from None
        length = response.headers.get('Content-Length')
        if length and length.isascii() and length.isdigit() and len(raw)!=int(length): raise BridgeError('UPSTREAM_INCOMPLETE_RESPONSE',503)
        status = response.status
        if not 200 <= status < 300:
            raise BridgeError('UPSTREAM_HTTP_' + str(status), status, response.headers.get('Retry-After'))
        if len(raw) > 1024 * 1024: raise BridgeError('UPSTREAM_RESPONSE_TOO_LARGE', 502)
        try: result = json.loads(raw)
        except (ValueError, UnicodeError): raise BridgeError('UPSTREAM_INVALID_JSON', 502) from None
        if not isinstance(result, dict): raise BridgeError('UPSTREAM_INVALID_JSON', 502)
        return result

def event_fields(raw: bytes, content_type: str) -> dict:
    if len(raw) > 32768: raise BridgeError('PAYLOAD_TOO_LARGE', 413)
    try:
        if content_type.split(';')[0].strip() == 'application/json':
            data = json.loads(raw)
            auth = data.get('auth') or {}
            return {'event':data['event'],'id':str(data['data']['FIELDS']['ID']), 'domain':auth['domain'], 'member_id':auth['member_id'], 'token':auth['application_token']}
        if content_type.split(';')[0].strip() != 'application/x-www-form-urlencoded': raise BridgeError('UNSUPPORTED_CONTENT_TYPE',415)
        values = urllib.parse.parse_qs(raw.decode('utf-8'), keep_blank_values=True, max_num_fields=100)
        keys = {'event':'event','id':'data[FIELDS][ID]','domain':'auth[domain]','member_id':'auth[member_id]','token':'auth[application_token]'}
        if any(len(values.get(k, [])) != 1 for k in keys.values()): raise ValueError()
        return {name:values[key][0] for name,key in keys.items()}
    except (KeyError, TypeError, AttributeError, UnicodeError, ValueError):
        raise BridgeError('INVALID_EVENT',400) from None

def phone(value):
    if not isinstance(value,str) or re.search(r'[^+0-9 ()-]',value): raise BridgeError('INVALID_CONTACT_PHONE',422)
    value = re.sub(r'[ ()-]','',value)
    if re.fullmatch(r'8[0-9]{10}',value): value = '7' + value[1:]
    if re.fullmatch(r'7[0-9]{10}',value): value = '+' + value
    if not re.fullmatch(r'\+[1-9][0-9]{7,14}',value): raise BridgeError('INVALID_CONTACT_PHONE',422)
    return value

class Bridge:
    def __init__(self, config: Config, database: str, transport=http_json, clock=time.time):
        self.config, self.transport, self.clock = config, transport, clock
        path = Path(database)
        path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
        self.db = sqlite3.connect(path, timeout=10)
        os.chmod(path,0o600)
        self.db.row_factory = sqlite3.Row
        self.db.execute('PRAGMA journal_mode=WAL')
        self.db.execute('''CREATE TABLE IF NOT EXISTS outbox (
          id TEXT PRIMARY KEY, event_key TEXT UNIQUE NOT NULL, deal_id TEXT NOT NULL,
          state TEXT NOT NULL DEFAULT 'pending', body TEXT, message_id TEXT, attempts INTEGER NOT NULL DEFAULT 0,
          due REAL NOT NULL DEFAULT 0, lease TEXT, lease_until REAL, error TEXT, created REAL NOT NULL
        )''')
        self.db.commit()
    def close(self): self.db.close()
    def accept(self, raw, content_type):
        event = event_fields(raw, content_type)
        c = self.config
        for received,expected in [(event['domain'],c.portal),(event['member_id'],c.member_id),(event['token'],c.application_token)]:
            if not isinstance(received,str) or not hmac.compare_digest(received.encode(), expected.encode()): raise BridgeError('INVALID_EVENT_AUTH',403)
        if event['event'] != 'ONCRMDEALADD': raise BridgeError('UNSUPPORTED_EVENT',400)
        if not re.fullmatch(r'[1-9][0-9]{0,18}',event['id']): raise BridgeError('INVALID_DEAL_ID',400)
        event_key = hashlib.sha256(f'{c.member_id}:ONCRMDEALADD:{event["id"]}'.encode()).hexdigest()
        with self.db:
            self.db.execute('INSERT OR IGNORE INTO outbox(id,event_key,deal_id,created) VALUES(?,?,?,?)',(str(uuid.uuid4()),event_key,event['id'],self.clock()))
        row = self.db.execute('SELECT id,state FROM outbox WHERE event_key=?',(event_key,)).fetchone()
        return dict(row)
    def _claim(self):
        now = self.clock()
        self.db.execute('BEGIN IMMEDIATE')
        try:
            self.db.execute("UPDATE outbox SET state='blocked',error='RETRY_LIMIT' WHERE attempts>=5 AND (state='retry' OR (state='processing' AND lease_until<?))",(now,))
            row = self.db.execute("SELECT * FROM outbox WHERE (state IN ('pending','retry') AND due<=?) OR (state='processing' AND lease_until<?) ORDER BY created LIMIT 1",(now,now)).fetchone()
            if row is None: self.db.commit(); return None
            lease = str(uuid.uuid4())
            self.db.execute("UPDATE outbox SET state='processing',lease=?,lease_until=?,attempts=attempts+1 WHERE id=?",(lease,now+300,row['id']))
            self.db.commit()
            return {**dict(row),'lease':lease,'attempts':row['attempts']+1}
        except Exception: self.db.rollback(); raise
    def _update(self, row, **fields):
        with self.db:
            changed = self.db.execute('UPDATE outbox SET '+','.join(k+'=?' for k in fields)+' WHERE id=? AND lease=?',(*fields.values(),row['id'],row['lease'])).rowcount
        if not changed: raise BridgeError('LEASE_EXPIRED',409)
    def _crm(self, method, id):
        result = self.transport(self.config.rest_base+method+'.json', {'id':id})
        if result.get('error'):
            code = result['error']
            raise BridgeError('CRM_RATE_LIMIT' if code in ('QUERY_LIMIT_EXCEEDED','OPERATION_TIME_LIMIT') else 'CRM_ERROR',429 if code in ('QUERY_LIMIT_EXCEEDED','OPERATION_TIME_LIMIT') else 422)
        if not isinstance(result.get('result'),dict): raise BridgeError('CRM_INVALID_RESPONSE',502)
        return result['result']
    def _prepare(self, row):
        deal = self._crm('crm.deal.get',row['deal_id'])
        contact_id = str(deal.get('CONTACT_ID',''))
        if not re.fullmatch(r'[1-9][0-9]*',contact_id): raise BridgeError('NO_PRIMARY_CONTACT',422)
        contact = self._crm('crm.contact.get',contact_id)
        # Consent must come from a field maintained by the client's consent process.
        if contact.get(self.config.consent_field) not in (True,1,'1','Y'): raise BridgeError('NO_WHATSAPP_CONSENT',422)
        values = contact.get('PHONE')
        if not isinstance(values,list): raise BridgeError('CONTACT_PHONE_AMBIGUOUS',422)
        numbers = {phone(item.get('VALUE')) for item in values if isinstance(item,dict) and item.get('VALUE')}
        if len(numbers)!=1: raise BridgeError('CONTACT_PHONE_AMBIGUOUS',422)
        return {'connection_id':self.config.connection_id,'to':numbers.pop(),'type':'template','template':{'name':self.config.template,'language':{'code':self.config.language},'components':[{'type':'body','parameters':[{'type':'text','text':row['deal_id']}]}]}}
    def work_once(self):
        row = self._claim()
        if row is None: return False
        try:
            body = json.loads(row['body']) if row['body'] else self._prepare(row)
            if not row['body']:
                self._update(row,body=json.dumps(body,ensure_ascii=False,sort_keys=True))
            # The frozen body and UUID are reused after a crash or uncertain network result.
            result = self.transport('https://waix.kz/api/v1/messages',body,{'Authorization':'Bearer '+self.config.waix_key,'Idempotency-Key':row['id']})
            message_id = result.get('data',{}).get('id') if isinstance(result.get('data'),dict) else None
            if not isinstance(message_id,str) or not UUID.fullmatch(message_id): raise BridgeError('WAIX_INVALID_RESPONSE',502)
            self._update(row,state='accepted',message_id=message_id,error=None,lease_until=None)
        except BridgeError as error:
            if error.code=='LEASE_EXPIRED': return True
            retryable = error.status==429 or error.status>=500
            state = 'retry' if retryable and row['attempts']<5 else 'blocked'
            delay = min(3600,30*2**min(row['attempts'],7))
            if error.retry_after and re.fullmatch(r'[0-9]{1,8}',error.retry_after): delay=max(delay,int(error.retry_after))
            self._update(row,state=state,error=error.code,due=self.clock()+delay,lease_until=None)
        return True
    def status(self):
        return [dict(r) for r in self.db.execute('SELECT id,deal_id,state,message_id,attempts,due,error FROM outbox ORDER BY created DESC LIMIT 100')]

def main():
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('command',choices=['serve','work','status'])
    parser.add_argument('--database',default='state/outbox.sqlite3')
    parser.add_argument('--port',type=int,default=8787)
    parser.add_argument('--once',action='store_true')
    args=parser.parse_args()
    os.umask(0o077)
    config=Config.from_env()
    if args.command in ('work','status'):
        bridge=Bridge(config,args.database)
        try:
            if args.command=='status': print(json.dumps(bridge.status(),ensure_ascii=False));return
            while True:
                did_work=bridge.work_once()
                if args.once:return
                if not did_work:time.sleep(1)
        finally:bridge.close()
    class Handler(BaseHTTPRequestHandler):
        def log_message(self,*args):pass
        def do_POST(self):
            self.connection.settimeout(10)
            try:
                if self.path!='/bitrix/deal':raise BridgeError('NOT_FOUND',404)
                if self.headers.get('Transfer-Encoding'):raise BridgeError('CONTENT_LENGTH_REQUIRED',411)
                length=int(self.headers.get('Content-Length','0'))
                if length<=0 or length>32768:raise BridgeError('PAYLOAD_TOO_LARGE',413)
                raw=self.rfile.read(length)
                if len(raw)!=length:raise BridgeError('INCOMPLETE_REQUEST',400)
                bridge=Bridge(config,args.database)
                try:result={'data':bridge.accept(raw,self.headers.get('Content-Type',''))}
                finally:bridge.close()
                status=200
            except BridgeError as e:result={'error':e.code};status=e.status
            except (ValueError,OSError,sqlite3.Error):result={'error':'TEMPORARILY_UNAVAILABLE'};status=503
            payload=json.dumps(result).encode()
            self.send_response(status);self.send_header('Content-Type','application/json');self.send_header('Cache-Control','no-store');self.send_header('Content-Length',str(len(payload)));self.end_headers();self.wfile.write(payload)
    ThreadingHTTPServer(('127.0.0.1',args.port),Handler).serve_forever()
if __name__=='__main__':main()
