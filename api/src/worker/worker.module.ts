import { Module } from '@nestjs/common';
import { ProberService } from './prober.service';
import { CheckRunnerService } from './check-runner.service';
import { SchedulerService } from './scheduler.service';

/**
 * The background half of the service.
 *
 * SchedulerService is only registered when WORKER_ENABLED is not "false", so the
 * same image can run as an API-only process or as API-plus-worker. Running two API
 * instances without this switch would probe every monitor twice.
 */
@Module({
  providers: [
    ProberService,
    CheckRunnerService,
    ...(process.env.WORKER_ENABLED === 'false' ? [] : [SchedulerService]),
  ],
  exports: [ProberService, CheckRunnerService],
})
export class WorkerModule {}
