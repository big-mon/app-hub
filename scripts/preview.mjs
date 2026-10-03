import fs from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {pathToFileURL} from 'node:url';
import assert from 'node:assert/strict';

export const marker='<!-- app-hub-verified-preview -->';
export const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
export function previewUrl(value){
 const u=new URL(value);
 if(u.protocol!=='https:'||!/^[-a-z0-9]+\.[-a-z0-9]+\.pages\.dev$/.test(u.hostname)||u.username||u.password||u.port||u.pathname!=='/'||u.search||u.hash)throw Error('Expected a Cloudflare Pages deployment origin');
 return u.origin;
}
const git=cwd=>execFileSync('git',['rev-parse','HEAD'],{cwd,encoding:'utf8'}).trim();
const stationView=data=>data.stations.map(s=>({id:s.id,name:s.id,coordinates:s.coords,aliases:s.aliases||[]}));
export const previewTarget=tools=>tools.find(t=>t.slug==='rail-meet'&&t.repo==='https://github.com/big-mon/rail-meet'&&/^[a-f0-9]{40}$/.test(t.commit||'')&&t.apiWorker==='api-worker.mjs');
export async function stamp(){
 const tools=JSON.parse(await fs.readFile('tools.json'));
 const tool=previewTarget(tools);
 if(process.env.GITHUB_OUTPUT)await fs.appendFile(process.env.GITHUB_OUTPUT,`rail_preview=${Boolean(tool)}\n`);
 if(!tool){console.log('Manifest has no supported pinned rail-meet API entry; skipping rail-specific preview.');return;}
 if(process.env.GITHUB_ACTIONS)assert.match(process.env.PROJECT_NAME||'',/^[a-z0-9-]+$/,'Missing or invalid existing PROJECT_NAME');
 const railSha=git('_tmp/rail-meet');assert.equal(railSha,tool.commit,'Clone must match the tracked pin');
 const networkBytes=await fs.readFile('dist/rail-meet/network.json');const data=JSON.parse(networkBytes);
 const engine=await import(pathToFileURL(`${process.cwd()}/dist/rail-meet/engine.mjs`));
 const uiAssets={};for(const name of ['app.mjs','style.css'])uiAssets[name]=hash(await fs.readFile('dist/rail-meet/'+name));
 const metadata={htmlSha256:hash(await fs.readFile('dist/rail-meet/index.html')),uiAssets,hubSha:git('.'),railSha,networkSha256:hash(networkBytes),heroSha256:hash(await fs.readFile('dist/rail-meet/hero-smile.png')),stations:data.stations.length,edges:data.edges.length};
 await fs.writeFile('dist/preview-build.json',JSON.stringify(metadata));
 const expected={metadata,html:await fs.readFile('dist/rail-meet/index.html','utf8'),stations:stationView(data),candidates:engine.recommend(data,['千葉','横浜'])};
 await fs.writeFile('preview-expected.json',JSON.stringify(expected));
 console.log(JSON.stringify(metadata));
}
export async function verify(origin,expected,fetcher=fetch){
 origin=previewUrl(origin);
 async function get(path,options){const r=await fetcher(origin+path,{redirect:'error',signal:AbortSignal.timeout(15000),...options});assert.equal(r.status,200,path);return r;}
 assert.deepEqual(await(await get('/preview-build.json')).json(),expected.metadata,'Preview belongs to another build');
 const html=await(await get('/rail-meet/')).text();
 if(hash(Buffer.from(html))!==expected.metadata.htmlSha256){
  let i=0;while(i<html.length&&html[i]===expected.html[i])i++;
  throw Error('HTML mismatch '+JSON.stringify({offset:i,expected:expected.html.slice(Math.max(0,i-60),i+180),actual:html.slice(Math.max(0,i-60),i+180),expectedLength:expected.html.length,actualLength:html.length}));
 }
 assert.match(html,/<title>みんなの中間駅/);assert.match(html,/id="find"/);assert.match(html,/id="map"/);
 assert.equal(hash(Buffer.from(await(await get('/rail-meet/network.json')).arrayBuffer())),expected.metadata.networkSha256,'Network mismatch');
 assert.equal(hash(Buffer.from(await(await get('/rail-meet/hero-smile.png')).arrayBuffer())),expected.metadata.heroSha256,'Character asset mismatch');
 for(const [name,sha] of Object.entries(expected.metadata.uiAssets))assert.equal(hash(Buffer.from(await(await get('/rail-meet/'+name)).arrayBuffer())),sha,'UI asset mismatch: '+name);
 const stations=await(await get('/rail-meet/api/v1/stations')).json();assert.equal(stations.count,expected.stations.length);assert.deepEqual(stations.stations,expected.stations);
 const result=await(await get('/rail-meet/api/v1/recommendations',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({origins:['千葉','横浜']})})).json();
 assert.deepEqual(result.candidates,expected.candidates,'API is serving another network or engine');
 return {...expected.metadata,url:origin+'/rail-meet/'};
}
export function commentBody(result,state='verified'){
 if(state!=='verified')return `${marker}\n\n${state==='pending'?'新しいheadのプレビューは検証待ちです。失敗・キャンセル時はURLを掲載しません。':'このmanifestはrail-meet専用プレビューの対象外です。URLは掲載しません。'}\n\napp-hub: \`${result.hubSha}\``;
 return `${marker}\n\n検証済みプレビュー: ${result.url}\n\n- app-hub: \`${result.hubSha}\`\n- rail-meet: \`${result.railSha}\`\n- ${result.stations}駅・${result.edges}区間\n\n配信先の版情報・HTML・画面JS/CSS・地図データ・キャラクター画像・駅一覧API・集合駅APIをビルド成果物と照合済み。\n\n<!-- rail-meet-preview ${JSON.stringify(result)} -->`;
}
async function comment(state='verified'){
 const repo=process.env.GH_REPO,number=process.env.PR_NUMBER;
 assert.equal(repo,'big-mon/app-hub');assert.match(number,/^[1-9][0-9]*$/);
 const result=state==='verified'?JSON.parse(await fs.readFile('verified-preview.json')):{hubSha:git('.')};
 const api=(route,args=[],body)=>JSON.parse(execFileSync('gh',['api',route,...args,...(body?['--input','-']:[])],{encoding:'utf8',input:body?JSON.stringify(body):undefined}));
 const pr=api(`repos/${repo}/pulls/${number}`);assert.equal(pr.head.sha,result.hubSha,'PR advanced; refusing a stale preview link');
 const comments=api(`repos/${repo}/issues/${number}/comments`,['--paginate','--slurp']).flat();
 const existing=comments.find(c=>c.user.login==='github-actions[bot]'&&c.body.startsWith(marker));
 const route=existing?`repos/${repo}/issues/comments/${existing.id}`:`repos/${repo}/issues/${number}/comments`;
 const saved=api(route,['--method',existing?'PATCH':'POST'],{body:commentBody(result,state)});
 console.log(saved.html_url);
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){
 const mode=process.argv[2];
 if(mode==='stamp')await stamp();
 else if(mode==='verify'){
  const expected=JSON.parse(await fs.readFile('preview-expected.json'));let result;
  for(let attempt=0;attempt<5;attempt++){
   try{result=await verify(process.env.PREVIEW_URL,expected);break;}
   catch(error){if(attempt===4){console.error('::error::'+error.message.replaceAll('%','%25').replaceAll('\r','%0D').replaceAll('\n','%0A'));throw error;}await new Promise(r=>setTimeout(r,5000));}
  }
  await fs.writeFile('verified-preview.json',JSON.stringify(result));
  console.log(JSON.stringify(result));
  if(process.env.GITHUB_STEP_SUMMARY)await fs.appendFile(process.env.GITHUB_STEP_SUMMARY,commentBody(result)+'\n');
 }else if(mode==='comment')await comment();
 else if(['pending','unsupported'].includes(mode))await comment(mode);
 else throw Error('Expected stamp, verify, comment, pending or unsupported');
}
