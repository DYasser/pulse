import { Global, Module } from '@nestjs/common';
import { PrismaService } from './prisma.service';

/** Global so feature modules do not each have to import it. */
@Global()
@Module({
  providers: [PrismaService],
  exports: [PrismaService],
})
export class PrismaModule {}
