import { Module } from '@nestjs/common';
import { MonitorsService } from './monitors.service';
import { MonitorsController } from './monitors.controller';
import { WorkerModule } from '../worker/worker.module';

@Module({
  // For AddressGuardService: a URL is refused at creation time as well as at
  // probe time, so the user is told why rather than seeing opaque failures.
  imports: [WorkerModule],
  controllers: [MonitorsController],
  providers: [MonitorsService],
  exports: [MonitorsService],
})
export class MonitorsModule {}
