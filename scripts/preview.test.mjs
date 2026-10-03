import {test} from 'node:test';import assert from 'node:assert/strict';
import {hash,verify,previewUrl,commentBody,marker,previewTarget} from './preview.mjs';
const html='<title>みんなの中間駅</title><button id="find"></button><div id="map"></div>';
const network='{"stations":[]}',hero='character bytes';
const expected={metadata:{htmlSha256:hash(html),uiAssets:{'app.mjs':hash('picker js'),'style.css':hash('picker css')},hubSha:'a'.repeat(40),railSha:'b'.repeat(40),networkSha256:hash(network),heroSha256:hash(hero),stations:0,edges:0},stations:[],candidates:[]};
function fixture(changes={}){return async(url,options)=>{const p=new URL(url).pathname;const routes={'/preview-build.json':expected.metadata,'/rail-meet/app.mjs':'picker js','/rail-meet/style.css':'picker css','/rail-meet/':html,'/rail-meet/network.json':network,'/rail-meet/hero-smile.png':hero,'/rail-meet/api/v1/stations':{count:0,stations:[]},'/rail-meet/api/v1/recommendations':{candidates:[]},...changes};if(p.endsWith('recommendations')){assert.equal(options.method,'POST');assert.deepEqual(JSON.parse(options.body),{origins:['千葉','横浜']});}const body=routes[p];return new Response(typeof body==='string'?body:JSON.stringify(body));};}
test('accept only Pages origins',()=>{assert.equal(previewUrl('https://abc.project.pages.dev'), 'https://abc.project.pages.dev');});
test('verify exact deployed build and reject fallback/stale assets/API',async()=>{
 const url='https://abc.project.pages.dev';const result=await verify(url,expected,fixture());assert.equal(result.railSha,expected.metadata.railSha);assert(commentBody(result).startsWith(marker));
 for(const changes of [{'/rail-meet/':html+'<script src="old.js"></script>'},{'/rail-meet/app.mjs':'old UI'},{'/rail-meet/style.css':'old style'},{'/preview-build.json':{...expected.metadata,railSha:'c'.repeat(40)}},{'/rail-meet/':'<title>App Hub</title>'},{'/rail-meet/network.json':'old network'},{'/rail-meet/hero-smile.png':'old character'},{'/rail-meet/api/v1/stations':{count:76,stations:[]}},{'/rail-meet/api/v1/recommendations':{candidates:[{station:'old'}]}}])await assert.rejects(verify(url,expected,fixture(changes)));
 for(const bad of ['http://abc.project.pages.dev','https://evil.test','https://abc.project.pages.dev/rail-meet/','https://u:p@abc.project.pages.dev','https://abc.project.pages.dev/?x=1'])assert.throws(()=>previewUrl(bad));
});

test('skip manifest entries outside the supported pinned rail API contract',()=>{
 const tool={slug:'rail-meet',repo:'https://github.com/big-mon/rail-meet',commit:'a'.repeat(40),apiWorker:'api-worker.mjs'};
 assert.equal(previewTarget([tool]),tool);
 for(const change of [{slug:'renamed'},{repo:'https://github.com/example/other'},{commit:undefined},{apiWorker:undefined}])assert.equal(previewTarget([{...tool,...change}]),undefined);
 assert.equal(previewTarget([]),undefined);
});
test('pending and unsupported states remove old URLs and verified metadata',()=>{
 const result={...expected.metadata,url:'https://abc.project.pages.dev/rail-meet/'};
 for(const state of ['pending','unsupported']){const body=commentBody(result,state);assert(body.startsWith(marker));assert(body.includes(result.hubSha));assert(!body.includes(result.url));assert(!body.includes('rail-meet-preview {'));assert(!body.includes('検証済みプレビュー'));}
});
test('removed tool exits stamp successfully without clone, dist or Cloudflare settings',async()=>{
 const fs=await import('node:fs/promises'),os=await import('node:os'),path=await import('node:path');
 const {execFileSync}=await import('node:child_process');
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),'preview-removed-'));
 try{
  await fs.writeFile(path.join(dir,'tools.json'),'[]');
  execFileSync(process.execPath,[new URL('./preview.mjs',import.meta.url).pathname,'stamp'],{cwd:dir,env:{...process.env,GITHUB_ACTIONS:'true',PROJECT_NAME:'',GITHUB_OUTPUT:path.join(dir,'output')}});
  assert.equal(await fs.readFile(path.join(dir,'output'),'utf8'),'rail_preview=false\n');
 }finally{await fs.rm(dir,{recursive:true,force:true});}
});
