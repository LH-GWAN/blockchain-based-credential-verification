#!/usr/bin/env node
// `next dev` 래퍼. pnpm 12 는 `pnpm --filter @dbp/verifier-app dev -- -p 3001` 의 `--` 를 스크립트에 그대로 넘기는데,
// next 는 `--` 뒤의 `-p` 를 프로젝트 디렉터리로 오해한다(scripts/demo.sh 가 이 형태로 호출). `--` 를 걸러내고
// 포트가 없으면 3001(지갑 3000 과 충돌 방지)을 기본값으로 쓴다.
import { spawn } from "node:child_process";
import { createRequire } from "node:module";

const args = process.argv.slice(2).filter((a) => a !== "--");
if (!args.some((a) => a === "-p" || a === "--port" || a.startsWith("--port="))) args.push("-p", "3001");

const nextBin = createRequire(import.meta.url).resolve("next/dist/bin/next");
const child = spawn(process.execPath, [nextBin, "dev", ...args], { stdio: "inherit" });
child.on("exit", (code, signal) => {
  if (signal) process.kill(process.pid, signal);
  else process.exit(code ?? 0);
});
for (const sig of ["SIGINT", "SIGTERM"]) process.on(sig, () => child.kill(sig));
