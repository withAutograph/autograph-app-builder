/** Observe only the candidate's Git metadata; never treat its current files as the original baseline. */
export const localPlanningGitPresenceProgram = String.raw`
const fs=require("node:fs");const path=require("node:path");const input=JSON.parse(process.argv[1]);
const root=fs.realpathSync(input.root);if(root!==input.root||!fs.lstatSync(root).isDirectory())throw Error("Local candidate boundary is invalid.");
let info;try{info=fs.lstatSync(path.join(root,".git"));}catch(error){if(error.code!=="ENOENT")throw error;}
if(info?.isSymbolicLink())throw Error("Local candidate Git metadata cannot be a symlink.");
console.log(JSON.stringify({present:info!==undefined}));
`;

/** Install complete, verified baseline Git objects atomically without checking out or changing one candidate byte. */
export const initializeLocalPlanningGitBaseProgram = String.raw`
const fs=require("node:fs");const path=require("node:path");const {execFileSync}=require("node:child_process");
const input=JSON.parse(process.argv[1]);
if(!/^[a-f0-9]{40}$/.test(input.sourceSha)||!/^[a-f0-9]{40}$/.test(input.sourceTree)||(input.originalSourceSha!==undefined&&!/^[a-f0-9]{40}$/.test(input.originalSourceSha)))throw Error("Original source identity is invalid.");
const root=fs.realpathSync(input.root);if(root!==input.root||!fs.lstatSync(root).isDirectory())throw Error("Local candidate boundary is invalid.");
const destination=path.join(root,".git");let existing;try{existing=fs.lstatSync(destination);}catch(error){if(error.code!=="ENOENT")throw error;}
if(existing)throw Error("Local candidate Git metadata appeared during baseline recovery; the candidate is retained.");
fs.mkdirSync(input.stateRoot,{recursive:true,mode:448});const temporary=fs.mkdtempSync(path.join(input.stateRoot,"git-base-"));
const git=fs.existsSync("/usr/bin/git")?"/usr/bin/git":"/bin/git";
const env={PATH:"/usr/bin:/bin",GIT_CONFIG_NOSYSTEM:"1",GIT_CONFIG_SYSTEM:"/dev/null",GIT_CONFIG_GLOBAL:"/dev/null",GIT_ATTR_NOSYSTEM:"1",GIT_NO_LAZY_FETCH:"1",GIT_TERMINAL_PROMPT:"0"};
const fixed=["-c","core.hooksPath=/dev/null","-c","core.fsmonitor=false","-c","core.attributesFile=/dev/null","-c","credential.helper=","-c","commit.gpgsign=false","-c","protocol.allow=never"];
const run=(args,options={})=>execFileSync(git,[...fixed,...args],{env,encoding:"utf8",maxBuffer:Infinity,stdio:["ignore","pipe","pipe"],...options}).trim();
try{
 run(["init","--quiet","--template=",temporary]);const gitDir=path.join(temporary,".git");const args=["--git-dir",gitDir];
 const pack=fs.openSync(input.packPath,"r");try{run([...args,"index-pack","--stdin"],{stdio:[pack,"pipe","pipe"]});}finally{fs.closeSync(pack);}
 run([...args,"cat-file","-e",input.sourceSha+"^{commit}"]);
 if(run([...args,"rev-parse",input.sourceSha+"^{tree}"])!==input.sourceTree)throw Error("Imported original source tree does not match its proven baseline.");
 // Only this actual commit and its complete tree were transported. The exact
 // commit remains unchanged; standard shallow metadata bounds ancestry reads.
 const retained=[...new Set([input.sourceSha,...(input.originalSourceSha===undefined?[]:[input.originalSourceSha])])];
 for(const sha of retained)run([...args,"cat-file","-e",sha+"^{commit}"]);
 fs.writeFileSync(path.join(gitDir,"shallow"),retained.join("\n")+"\n",{mode:384});
 run([...args,"symbolic-ref","HEAD","refs/heads/app-builder-local-base"]);
 run([...args,"update-ref","refs/heads/app-builder-local-base",input.sourceSha]);
 run([...args,"read-tree",input.sourceSha]);
 if(fs.existsSync(destination))throw Error("Local candidate Git metadata appeared during baseline recovery.");
 fs.renameSync(gitDir,destination);
 console.log(JSON.stringify({sourceSha:input.sourceSha,sourceTree:input.sourceTree}));
}finally{fs.rmSync(temporary,{recursive:true,force:true});}
`;
/** Retain the real captured host commit/tree as objects, without importing its history or checking out files. */
export const importLocalPlanningCurrentCommitProgram = String.raw`
const fs=require("node:fs");const path=require("node:path");const {execFileSync}=require("node:child_process");
const input=JSON.parse(process.argv[1]);
if(!/^[a-f0-9]{40}$/.test(input.sourceSha)||!/^[a-f0-9]{40}$/.test(input.sourceTree))throw Error("Current source identity is invalid.");
const root=fs.realpathSync(input.root);if(root!==input.root||!fs.lstatSync(root).isDirectory())throw Error("Local candidate boundary is invalid.");
const gitDir=path.join(root,".git");if(!fs.lstatSync(gitDir).isDirectory()||fs.realpathSync(gitDir)!==gitDir)throw Error("Local candidate Git metadata is invalid.");
const git=fs.existsSync("/usr/bin/git")?"/usr/bin/git":"/bin/git";
const env={PATH:"/usr/bin:/bin",GIT_CONFIG_NOSYSTEM:"1",GIT_CONFIG_SYSTEM:"/dev/null",GIT_CONFIG_GLOBAL:"/dev/null",GIT_ATTR_NOSYSTEM:"1",GIT_NO_LAZY_FETCH:"1",GIT_TERMINAL_PROMPT:"0"};
const fixed=["-c","core.hooksPath=/dev/null","-c","core.fsmonitor=false","-c","core.attributesFile=/dev/null","-c","credential.helper=","-c","protocol.allow=never","--git-dir",gitDir];
const run=(args,options={})=>execFileSync(git,[...fixed,...args],{env,encoding:"utf8",maxBuffer:Infinity,stdio:["ignore","pipe","pipe"],...options}).trim();
const pack=fs.openSync(input.packPath,"r");try{run(["index-pack","--stdin"],{stdio:[pack,"pipe","pipe"]});}finally{fs.closeSync(pack);}
run(["cat-file","-e",input.sourceSha+"^{commit}"]);
if(run(["rev-parse",input.sourceSha+"^{tree}"])!==input.sourceTree)throw Error("Current source tree does not match captured host identity.");
const shallow=path.join(gitDir,"shallow");let entries=[];try{entries=fs.readFileSync(shallow,"utf8").trim().split("\n").filter(Boolean);}catch(error){if(error.code!=="ENOENT")throw error;}
if(!entries.includes(input.sourceSha)){entries.push(input.sourceSha);fs.writeFileSync(shallow,entries.join("\n")+"\n",{mode:384});}
const reference="refs/app-builder/reviewed-local-sources/"+input.sourceSha;
run(["update-ref",reference,input.sourceSha]);
if(run(["rev-parse",reference])!==input.sourceSha||run(["rev-parse",reference+"^{tree}"])!==input.sourceTree)throw Error("Current source private reference differs from captured identity.");
console.log(JSON.stringify({sourceSha:input.sourceSha,sourceTree:input.sourceTree}));
`;
