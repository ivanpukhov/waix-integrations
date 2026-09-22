import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
const key='f5bf0474-d4b6-4ca5-bd1b-92e44f3ad0fb';
for(const slug of ['website-form','order-notification','otp-send','otp-verify']){
 test(`n8n ${slug}: graph, request validation and API payload`,async()=>{
  const flow=JSON.parse(await readFile(new URL(`../n8n/${slug}.json`,import.meta.url),'utf8'));
  assert.equal(flow.active,false);assert.equal(flow.settings.saveDataSuccessExecution,'none');assert.equal(flow.settings.saveDataErrorExecution,'none');
  const names=new Set(flow.nodes.map(n=>n.name));for(const node of Object.values(flow.connections))for(const branch of node.main)for(const edge of branch)assert.ok(names.has(edge.node));
  const prepare=flow.nodes.find(n=>n.name==='Prepare request'),run=new Function('$json',prepare.parameters.jsCode.replace('REPLACE_CONNECTION_ID',key));
  assert.equal(run({body:{}})[0].json.valid,false);
  const request={event_id:key,phone:'+77071234567',whatsapp_consent:true,name:'Client "A"',order_number:'42',id:key,code:'123456'};
  const result=run({body:request})[0].json;assert.equal(result.valid,true);
  if(slug==='otp-verify')assert.deepEqual(result.body,{id:key,code:'123456'});
  else{assert.equal(result.idempotency_key,key);assert.equal(result.body.to,request.phone);}
  if(slug==='website-form'||slug==='order-notification')assert.equal(run({body:{...request,whatsapp_consent:false}})[0].json.valid,false);
  assert.equal(flow.nodes.find(n=>n.name==='Server webhook').parameters.authentication,'headerAuth');
  const http=flow.nodes.find(n=>n.name==='WAIX API');assert.equal(http.parameters.genericAuthType,'httpHeaderAuth');assert.equal(http.retryOnFail,undefined);assert.match(http.parameters.url,/^https:\/\/waix.kz\/api\/v1\//);
  const response=flow.nodes.find(n=>n.name==='Return API result').parameters.responseBody.slice(3,-2);
  const sanitize=new Function('$json',`return (${response});`);assert.equal(sanitize({body:{data:{id:key,test_code:'123456'}}}).data.test_code,undefined);
 });
}
