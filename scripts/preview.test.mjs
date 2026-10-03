import {test} from 'node:test';import assert from 'node:assert/strict';
import {hash,verify,previewUrl,commentBody,marker} from './preview.mjs';
const network='{"stations":[]}',hero='character bytes';
const expected={metadata:{hubSha:'a'.repeat(40),railSha:'b'.repeat(40),networkSha256:hash(network),heroSha256:hash(hero),stations:0,edges:0},stations:[],candidates:[]};
function fixture(changes={}){return async(url,options)=>{const p=new URL(url).pathname;const routes={'/preview-build.json':expected.metadata,'/rail-meet/':'<title>みんなの中間駅</title><button id="find"></button><div id="map"></div>','/rail-meet/network.json':network,'/rail-meet/hero-smile.png':hero,'/rail-meet/api/v1/stations':{count:0,stations:[]},'/rail-meet/api/v1/recommendations':{candidates:[]},...changes};if(p.endsWith('recommendations')){assert.equal(options.method,'POST');assert.deepEqual(JSON.parse(options.body),{origins:['千葉','横浜']});}const body=routes[p];return new Response(typeof body==='string'?body:JSON.stringify(body));};}
test('accept only Pages origins',()=>{assert.equal(previewUrl('https://abc.project.pages.dev'), 'https://abc.project.pages.dev');});
test('verify exact deployed build and reject fallback/stale assets/API',async()=>{
 const url='https://abc.project.pages.dev';const result=await verify(url,expected,fixture());assert.equal(result.railSha,expected.metadata.railSha);assert(commentBody(result).startsWith(marker));
 for(const changes of [{'/preview-build.json':{...expected.metadata,railSha:'c'.repeat(40)}},{'/rail-meet/':'<title>App Hub</title>'},{'/rail-meet/network.json':'old network'},{'/rail-meet/hero-smile.png':'old character'},{'/rail-meet/api/v1/stations':{count:76,stations:[]}},{'/rail-meet/api/v1/recommendations':{candidates:[{station:'old'}]}}])await assert.rejects(verify(url,expected,fixture(changes)));
 for(const bad of ['http://abc.project.pages.dev','https://evil.test','https://abc.project.pages.dev/rail-meet/','https://u:p@abc.project.pages.dev','https://abc.project.pages.dev/?x=1'])assert.throws(()=>previewUrl(bad));
});
