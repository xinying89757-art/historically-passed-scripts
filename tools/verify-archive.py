#!/usr/bin/env python3
"""Offline archive integrity check. Never contacts the product environment."""
from pathlib import Path
import hashlib,json,re,subprocess,sys
ROOT=Path(__file__).resolve().parent.parent
SKIP={'node_modules','.git','test-results','playwright-report'}
errors=[];counts={'javascript':0,'shell':0,'json':0,'python':0,'source_files':0}
if (ROOT/'.git').is_dir():
    tracked=subprocess.check_output(['git','ls-files','-s','-z'],cwd=ROOT).decode().split('\0')
    for entry in tracked:
        if entry.startswith('120000 '):errors.append('tracked symlink: '+entry.split('\t',1)[-1])
        if '\t' in entry and 'node_modules' in entry.split('\t',1)[1].split('/'):errors.append('tracked dependency path: '+entry.split('\t',1)[1])
files=[]
import os
for r,ds,fs in os.walk(ROOT):
 ds[:]=[d for d in ds if d not in SKIP]
 for f in fs:
  p=Path(r)/f
  if p.is_symlink():errors.append('unexpected file symlink: '+str(p.relative_to(ROOT)));continue
  files.append(p)
for p in files:
 rel=str(p.relative_to(ROOT))
 if (p.name in ['.env.local','local-test-config.json','admin.storage.json'] or (p.name=='admin-login.json' and 'config' in p.parts)) or any(x in p.parts for x in ['.auth','.state','state']):errors.append('local credential/runtime path: '+rel)
 if p.suffix in ['.mjs','.js','.cjs','.sh']:
  command=['bash','-n',str(p)] if p.suffix=='.sh' else ['node','--check',str(p)]
  r=subprocess.run(command,capture_output=True,text=True)
  counts['shell' if p.suffix=='.sh' else 'javascript']+=1
  if r.returncode:errors.append('syntax: '+rel)
 elif p.suffix=='.json':
  counts['json']+=1
  try:json.loads(p.read_text())
  except Exception:errors.append('invalid JSON: '+rel)
 elif p.suffix=='.py':
  counts['python']+=1
  try:compile(p.read_text(),rel,'exec')
  except Exception:errors.append('invalid Python: '+rel)
 if p.suffix in ['.mjs','.js','.ts','.cjs']:
  for imp in re.findall(r'(?:from\s*|import\s*\()\s*[\x27\"]([^\x27\"]+)',p.read_text()):
   if not imp.startswith('.'):continue
   candidate=p.parent/imp
   if candidate.exists():continue
   if candidate.suffix=='.js' and candidate.with_suffix('.ts').exists():continue
   errors.append('missing relative import: '+rel+' -> '+imp)
 text=p.read_text()
 # Generic patterns only: no sensitive-value corpus is stored in the repository.
 if re.search(r'(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{30,}|-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----)',text):errors.append('secret token pattern: '+rel)
 if re.search(r'/Users/[^/\s]+/(?:Desktop|Downloads|\.codex|codex-vibecoding)/',text):errors.append('personal absolute path: '+rel)
for entry in json.loads((ROOT/'catalog/provenance.json').read_text()):
 p=ROOT/entry['archive'];counts['source_files']+=1
 if not p.exists():errors.append('missing source file: '+entry['archive'])
 elif hashlib.sha256(p.read_bytes()).hexdigest()!=entry['archive_sha256']:errors.append('provenance hash mismatch: '+entry['archive'])
print(json.dumps({'ok':not errors,'counts':counts,'errors':errors},ensure_ascii=False,indent=2))
sys.exit(bool(errors))
