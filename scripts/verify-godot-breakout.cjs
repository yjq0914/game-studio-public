const {app}=require('electron');
const fs=require('node:fs/promises'),path=require('node:path'),assert=require('node:assert/strict');
const {pathToFileURL}=require('node:url');
const root=process.argv[2],resultFile=process.argv[3],out=process.argv[4];
if(!root||!resultFile||!out)throw Error("Usage: Electron verify-godot-breakout.cjs <repo-root> <creation-report.json> <output-directory>");
app.setPath('userData',path.join(root,'.data/breakout-independent-electron'));
app.on('window-all-closed',()=>{});
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
const report={kind:'independent Breakout real-input native and Web acceptance',runs:[]};
let runtime,driver,server;
const game=r=>r.state?.game??r.gameState?.game??r.gameState??{};
function reflect(x,min=25,max=615){const d=max-min;let v=((x-min)%(2*d)+2*d)%(2*d);return min+(v>d?2*d-v:v);}
function intercept(s){const b=s.ball;return reflect(b.x+b.vx*Math.max(0,(s.paddle.y-s.paddle.height/2-b.radius-b.y)/(b.vy||1)));}
function aim(s,mode){
  if(mode==='miss')return intercept(s)<320?560:80;
  const b=s.ball,p=s.paddle;
  if(b.vy<=0)return Math.max(76,Math.min(564,b.x));
  const hit=intercept(s);
  const choices=s.bricks??[];
  const brick=choices.slice().sort((a,b)=>Math.abs(a.x-hit)-Math.abs(b.x-hit))[0];
  const angle=brick?Math.atan2(brick.x-hit,p.y-brick.y):0.25;
  const offset=Math.max(-0.75,Math.min(0.75,angle/1.08))*p.width/2;
  return Math.max(76,Math.min(564,hit-offset));
}
async function exercise(label,io){
  const checks={label,events:[]};report.runs.push(checks);
  let s=await io.observe();checks.initial=s;
  await io.capture(label+'-menu');assert.equal(s.lives,3);assert.equal(s.score,0);assert.equal(s.bricks.length,12);
  const p0=s.paddle.x;s=await io.move(-1,180);assert(s.paddle.x<p0-30,'Left input moves paddle');
  const p1=s.paddle.x;s=await io.move(1,180);assert(s.paddle.x>p1+30,'Right input moves paddle');checks.leftRight=true;
  for(let i=0;i<3&&s.phase!=='playing';i++)s=await io.press('launch');
  assert.equal(s.phase,'playing','Space launches real ball');checks.start=true;
  const launched={...s.ball};s=await io.move(0,120);assert(Math.hypot(s.ball.x-launched.x,s.ball.y-launched.y)>10);checks.ballMotion=true;
  const end=Date.now()+5*60*1000;let before=s;let frames=0,lastScore=0;
  while(Date.now()<end&&s.phase!=='won'&&s.phase!=='lost'){
    if(s.phase==='ready'){s=await io.press('launch');continue;}
    const x=aim(s,'catch'),error=x-s.paddle.x;
    s=await io.move(Math.abs(error)>7?Math.sign(error):0,Math.min(75,Math.max(25,Math.abs(error)/430*1000)));
    if(s.score!==lastScore){checks.events.push({elapsedMs:Date.now()-(end-5*60*1000),phase:s.phase,score:s.score,lives:s.lives,bricks:s.bricks.length,paddle_hits:s.paddle_hits,wall_hits:s.wall_hits});lastScore=s.score;console.log(label,JSON.stringify(checks.events.at(-1)));}
    if(s.score>0&&!checks.scoring){assert(s.bricks.length<12&&s.bricks_destroyed>0);checks.scoring=true;checks.scored=s;await io.capture(label+'-scored');}
    if(s.paddle_hits>before.paddle_hits){checks.paddleBounce=true;}
    if(s.wall_hits>before.wall_hits){checks.wallBounce=true;}
    before=s;frames++;
  }
  checks.winState=s;checks.controllerFrames=frames;await io.capture(label+'-win-or-failure');
  assert.equal(s.phase,'won','Actual play must clear all bricks');assert.equal(s.bricks.length,0);assert.equal(s.score,1200);assert(checks.paddleBounce&&checks.wallBounce,'Actual paddle and wall collisions occurred');checks.win=true;
  s=await io.press('restart');assert.equal(s.phase,'ready');assert.equal(s.score,0);assert.equal(s.lives,3);assert.equal(s.bricks.length,12);checks.restartAfterWin=true;
  await io.capture(label+'-restart');
  const loseEnd=Date.now()+90000;let lastLives=s.lives;
  while(Date.now()<loseEnd&&s.phase!=='lost'){
    if(s.phase==='ready')s=await io.press('launch');
    const x=aim(s,'miss'),error=x-s.paddle.x;
    s=await io.move(Math.abs(error)>8?Math.sign(error):0,75);
    if(s.lives<lastLives){checks.events.push({kind:'ball_lost',lives:s.lives,phase:s.phase});checks.lifeLoss=true;lastLives=s.lives;}
  }
  checks.lossState=s;await io.capture(label+'-lost');assert.equal(s.phase,'lost');assert.equal(s.lives,0);checks.loss=true;
  s=await io.press('restart');assert.equal(s.phase,'ready');assert.equal(s.score,0);assert.equal(s.lives,3);assert.equal(s.bricks.length,12);assert.equal(s.bricks_destroyed,0);checks.restartAfterLoss=true;checks.final=s;
  await io.capture(label+'-final-reset');checks.status='passed';
}
app.whenReady().then(async()=>{
 try{
  await fs.mkdir(out,{recursive:true});
  const creation=JSON.parse(await fs.readFile(resultFile,'utf8'));const entry=creation.cases[0];
  const project={id:entry.projectId,type:'godot-game',workspacePath:entry.projectPath};report.project=entry;
  const {GodotRuntime,currentGodotWebDirectory}=await import(pathToFileURL(path.join(root,'dist/daemon/godot-runtime.js')));
  const {startStaticPreview}=await import(pathToFileURL(path.join(root,'dist/daemon/preview-static.js')));
  const {ElectronPlaytestDriver}=await import(pathToFileURL(path.join(root,'dist/desktop/playtest-driver.js')));
  const {createGameUseTool}=await import(pathToFileURL(path.join(root,'dist/daemon/playtest-tools.js')));
  const {guardGodotGameUse}=await import(pathToFileURL(path.join(root,'dist/daemon/godot-tools.js')));
  runtime=new GodotRuntime();driver=new ElectronPlaytestDriver(()=>{});
  const source=await fs.readFile(path.join(project.workspacePath,'main.gd'),'utf8');
  const actions=JSON.parse(process.env.BREAKOUT_ACTIONS??'{"launch":"serve","restart":"restart","left":"move_left","right":"move_right"}');
  report.actions=actions;report.generatedSourceBytes=source.length;
  const start=await runtime.start(project);report.nativeRevision=start.revision;
  const observe=async()=>game(await runtime.operate(project,'inspect'));
  const pulse=async(action,duration)=>game(await runtime.sequence(project,[{kind:'action',action,pressed:true},{kind:'wait',milliseconds:duration},{kind:'action',action,pressed:false},{kind:'wait',milliseconds:30}]));
  await exercise('native',{
   observe,
   move:async(direction,ms)=>direction?pulse(direction<0?actions.left:actions.right,Math.round(ms)):game(await runtime.sequence(project,[{kind:'wait',milliseconds:Math.round(ms)}])),
   press:kind=>pulse(actions[kind],20),
   capture:async label=>{const r=await runtime.operate(project,'capture');await fs.copyFile(path.join(project.workspacePath,r.capturePath),path.join(out,label+'.png'));}
  });
  await runtime.stop(project.id);
  const exported=await runtime.exportWeb(project);report.webRevision=exported.revision;assert.equal(report.nativeRevision,report.webRevision);
  server=await startStaticPreview(await currentGodotWebDirectory(project.workspacePath),0);
  const tool=guardGodotGameUse(project,createGameUseTool(driver,async()=>({runtime:'web',url:server.url+'/?ohmygamePlaytest=1',visible:true})));
  const call=input=>tool.execute('breakout-acceptance',input,undefined,undefined,{});
  const opened=await call({operation:'open',viewport:{width:640,height:720}});const sessionId=opened.details.playtest.sessionId;
  const webObserve=async()=>game((await call({operation:'inspect',sessionId})).details.playtest);
  const end=Date.now()+30000;while(!(await webObserve()).phase&&Date.now()<end)await sleep(200);
  await exercise('web',{
   observe:webObserve,
   move:async(direction,ms)=>game((await call({operation:'act',sessionId,actions:direction?[{type:'press',key:direction<0?'ArrowLeft':'ArrowRight',duration:Math.round(ms)},{type:'wait',milliseconds:30}]:[{type:'wait',milliseconds:Math.round(ms)}]})).details.playtest),
   press:async kind=>game((await call({operation:'act',sessionId,actions:[{type:'press',key:kind==='launch'?'Space':'r',duration:20},{type:'wait',milliseconds:130}]})).details.playtest),
   capture:async label=>{const r=await call({operation:'capture',sessionId});const i=r.content.find(c=>c.type==='image');await fs.writeFile(path.join(out,label+'.jpg'),Buffer.from(i.data,'base64'));}
  });
  const observation=(await call({operation:'inspect',sessionId})).details.playtest;report.webErrors=observation.logs.filter(x=>x.level==='error');report.failedRequests=observation.failedRequests;assert.equal(report.webErrors.length,0);assert.equal(report.failedRequests.length,0);
  await call({operation:'close',sessionId});report.status='passed';
 }catch(e){report.status='failed';report.error=String(e);console.error(e);}
 finally{await runtime?.close();driver?.close();await server?.close();await fs.writeFile(path.join(out,'打砖块独立验收.json'),JSON.stringify(report,null,2));console.log('Acceptance:',report.status);app.exit(report.status==='passed'?0:1);}
});
