from pathlib import Path
import subprocess,os,re,json,time,tempfile
b=Path(__file__).resolve().parent.parent;records=[]
log_dir=Path(tempfile.mkdtemp(prefix='historical-ui-offline-'))
for key in ['block-page','editor-3','ai-block','llms-txt','v4-portable']:
 tests=[];skips=[]
 for p in sorted((b/'suites'/key/'test').glob('*.test.mjs')):
  s=p.read_text();reason=''
  if re.search(r'\bchromium\b|\.launch\(',s):reason='browser fixture omitted from this offline pass'
  elif p.name.startswith('live-'):reason='live environment deliberately not executed'
  elif re.search(r'read(?:Ranking|Component|Workbook|V4Input)|config\.(?:inputCsv|rankingWorkbook|componentWorkbook)|readFile\(.*config\.',s):reason='requires local input/config fixture'
  if reason:skips.append({'file':p.name,'reason':reason})
  else:tests.append(str(p))
 skip_titles=['4.0全量审计输入覆盖24页215个实际添加区块','4.0页面001生成14条H目标和2个不支持区块','4.0批量计划覆盖除首个试跑页外的23页、348个H目标和21个不支持区块','历史失败项任务严格覆盖16页、58对象和74处H','六组件复核严格限制为2页6个组件6处H','真实全量JSON契约与排除数量一致','旧映射导入、排名状态优先和H2数量一致','H2试跑选择所有有可达非排名页面的模板代表且不重复','GB18030真实CSV按分类筛选并保持原顺序'] if key=='block-page' else (['GB18030真实CSV按分类筛选并保持原顺序'] if key=='v4-portable' else [])
 command=['node','--test','--test-reporter=tap',*( ['--test-skip-pattern='+'|'.join(re.escape(t) for t in skip_titles)] if skip_titles else []),*tests];start=time.time()
 try:
  r=subprocess.run(command,cwd=b/'suites'/key,env={**os.environ,'RUN_LIVE':'0'},capture_output=True,text=True,timeout=180)
  s=r.stdout+r.stderr;code=r.returncode
 except subprocess.TimeoutExpired as e:s=str(e);code=124
 (log_dir/(key+'-offline.log')).write_text(s)
 counts={k:int(v) for k,v in re.findall(r'^# (tests|pass|fail|skipped|cancelled|todo) (\d+)',s,re.M)}
 failures=re.findall(r'^not ok \d+ - (.+)',s,re.M)
 record={'suite':key,'test_files':len(tests),'excluded_files':skips,'requires_private_data_test_titles':skip_titles,'exit_code':code,'counts':counts,'failures':failures,'duration_seconds':round(time.time()-start,2)}
 records.append(record);print(json.dumps(record,ensure_ascii=False),flush=True)
 if code:
  excerpts=re.findall(r'not ok.*?(?=\n(?:ok|not ok|# Subtest|1\.\.)|\Z)',s,re.S)
  print('Failure details retained locally in '+str(log_dir),flush=True)
for key in ['permissions','permissions-current']:
 r=subprocess.run(['node',str(b/'node_modules/@playwright/test/cli.js'),'test','-c','playwright.unit.config.ts'],cwd=b/'suites'/key,env={**os.environ,'RUN_LIVE':'0'},capture_output=True,text=True,timeout=90)
 s=r.stdout+r.stderr;(log_dir/(key+'-offline.log')).write_text(s)
 records.append({'suite':key,'exit_code':r.returncode,'passed':int(re.search(r'(\d+) passed',s)[1]) if re.search(r'(\d+) passed',s) else 0})
 print(key,'exit_code',r.returncode,flush=True)
r=subprocess.run(['node','--test','tools/run-live.test.mjs'],cwd=b,capture_output=True,text=True)
records.append({'suite':'archive-config-guard','exit_code':r.returncode,'passed':4 if r.returncode==0 else 0});print('guard',r.returncode,flush=True)
(b/'catalog/offline-checks.json').write_text(json.dumps({'live_execution':False,'node_version':subprocess.check_output(['node','--version'],text=True).strip(),'tests':records},ensure_ascii=False,indent=2)+'\n')

raise SystemExit(1 if any(x['exit_code'] for x in records) else 0)
