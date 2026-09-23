import importlib.util
import json
import sys
import tempfile
import unittest
import urllib.parse
from pathlib import Path
spec=importlib.util.spec_from_file_location('bridge',Path(__file__).parents[1]/'bridge.py')
m=importlib.util.module_from_spec(spec);sys.modules['bridge']=m;spec.loader.exec_module(m)
KEY='f5bf0474-d4b6-4ca5-bd1b-92e44f3ad0fb'
class Tests(unittest.TestCase):
 def setUp(self):
  self.tmp=tempfile.TemporaryDirectory();self.calls=[];self.now=1000;self.fail=False;self.consent=True
  self.config=m.Config('demo.bitrix24.kz','member','fixture-token','https://demo.bitrix24.kz/rest/1/fixture/','fixture-waix',KEY,'order_ready','UF_CRM_CONSENT')
  self.bridge=m.Bridge(self.config,self.tmp.name+'/outbox.sqlite3',self.transport,lambda:self.now)
 def tearDown(self):self.bridge.close();self.tmp.cleanup()
 def transport(self,url,body,headers=None):
  self.calls.append((url,body,headers))
  if 'crm.deal.get' in url:return {'result':{'CONTACT_ID':10}}
  if 'crm.contact.get' in url:return {'result':{'PHONE':[{'VALUE':'8 (707) 123-45-67'}],'UF_CRM_CONSENT':self.consent}}
  if self.fail:raise m.BridgeError('UPSTREAM_UNAVAILABLE',503)
  return {'data':{'id':KEY,'status':'queued'}}
 def raw(self,**changes):
  values={'event':'ONCRMDEALADD','data[FIELDS][ID]':'42','auth[domain]':'demo.bitrix24.kz','auth[member_id]':'member','auth[application_token]':'fixture-token',**changes}
  return urllib.parse.urlencode(values).encode()
 def accept(self,**changes):return self.bridge.accept(self.raw(**changes),'application/x-www-form-urlencoded')
 def test_persistent_dedupe_and_frozen_payload_after_timeout(self):
  first=self.accept();self.fail=True;self.bridge.work_once();self.assertEqual(self.bridge.status()[0]['state'],'retry')
  replay=self.accept();self.assertEqual(first['id'],replay['id'])
  before=self.calls[-1];self.calls.clear();self.now+=1000;self.fail=False;self.consent=False
  self.bridge.work_once();self.assertEqual(len(self.calls),1);self.assertEqual(self.calls[-1],before)
  self.assertEqual(self.bridge.status()[0]['state'],'accepted');self.assertFalse(self.bridge.work_once())
  self.assertEqual(before[1]['to'],'+77071234567');self.assertEqual(before[2]['Idempotency-Key'],first['id'])
 def test_auth_portal_and_duplicates_rejected_before_queue(self):
  for changes in [{'auth[domain]':'evil.example'},{'auth[member_id]':'other'},{'auth[application_token]':'wrong'},{'event':'ONCRMDEALUPDATE'},{'data[FIELDS][ID]':'../42'}]:
   with self.assertRaises(m.BridgeError):self.accept(**changes)
  with self.assertRaises(m.BridgeError):self.bridge.accept(self.raw()+b'&auth[domain]=evil.example','application/x-www-form-urlencoded')
  self.assertEqual(self.bridge.status(),[]);self.assertEqual(self.calls,[])
 def test_no_consent_blocks_without_send(self):
  self.consent=False;self.accept();self.bridge.work_once()
  self.assertEqual(self.bridge.status()[0]['error'],'NO_WHATSAPP_CONSENT');self.assertEqual(len(self.calls),2)
 def test_crashed_lease_is_reclaimed_with_original_id(self):
  first=self.accept();job=self.bridge._claim();self.assertFalse(self.bridge.work_once());self.now+=301;self.bridge.work_once()
  self.assertEqual(self.calls[-1][2]['Idempotency-Key'],first['id'])
  with self.assertRaises(m.BridgeError):self.bridge._update(job,state='retry')
 def test_terminal_error_not_retried(self):
  def deny(*args):raise m.BridgeError('UPSTREAM_HTTP_401',401)
  self.bridge.transport=deny;self.accept();self.bridge.work_once();self.assertEqual(self.bridge.status()[0]['state'],'blocked')
 def test_retry_limit_survives_duplicate_events(self):
  self.fail=True;self.accept()
  for _ in range(5):self.now+=4000;self.bridge.work_once();self.accept()
  self.assertEqual(self.bridge.status()[0]['attempts'],5);self.assertEqual(self.bridge.status()[0]['state'],'blocked')
 def test_config_rejects_arbitrary_targets(self):
  values=dict(vars(self.config))
  for target in ['http://demo.bitrix24.kz/rest/1/fixture/','https://evil.example/rest/1/fixture/','https://demo.bitrix24.kz/rest/1/fixture/?next=evil']:
   with self.assertRaises(ValueError):m.Config(**{**values,'rest_base':target})
 def test_phone_rules(self):
  self.assertEqual(m.phone('+44 20 1234 5678'),'+442012345678')
  for value in ['7071234567','+7707bad4567','+77071234567 ext 2',77071234567]:
   with self.assertRaises(m.BridgeError):m.phone(value)
if __name__=='__main__':unittest.main()
