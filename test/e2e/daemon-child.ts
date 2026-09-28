// 재시작 테스트용 "첫 번째 데몬". 직원 실행이 시작되면 RUNNING을 출력하고 강제 종료를 기다린다.
import { Store } from '../../src/store/db.ts';
import { Company } from '../../src/app/company.ts';
import { Orchestrator } from '../../src/app/orchestrator.ts';

const [dbPath, dataDir, ticketId] = process.argv.slice(2) as [string, string, string];
const store = new Store(dbPath);
const orch = new Orchestrator(new Company(store), { dataDir });
for (;;) {
  await orch.tick();
  const running = orch.records.runsForTicket(ticketId).find((r) => r.status === 'running');
  if (running) {
    process.stdout.write(`RUNNING ${running.id} ${running.pid}\n`);
    break;
  }
  await new Promise((r) => setTimeout(r, 50));
}
setInterval(() => {}, 1000);
