import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { MonitorsService } from './monitors.service';
import { CreateMonitorDto } from './dto/create-monitor.dto';
import { UpdateMonitorDto } from './dto/update-monitor.dto';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { CurrentUser } from '../auth/current-user.decorator';
import type { RequestUser } from '../auth/jwt.strategy';

@Controller('monitors')
@UseGuards(JwtAuthGuard) // every route here requires a token
export class MonitorsController {
  constructor(private readonly monitors: MonitorsService) {}

  @Post()
  create(@CurrentUser() user: RequestUser, @Body() dto: CreateMonitorDto) {
    return this.monitors.create(user.id, dto);
  }

  @Get()
  findAll(@CurrentUser() user: RequestUser) {
    return this.monitors.findAll(user.id);
  }

  /** Declared before :id so "summary" is not parsed as a monitor id. */
  @Get('summary')
  summary(@CurrentUser() user: RequestUser) {
    return this.monitors.summary(user.id);
  }

  @Get(':id')
  findOne(
    @CurrentUser() user: RequestUser,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.monitors.findOne(user.id, id);
  }

  @Get(':id/checks')
  findChecks(
    @CurrentUser() user: RequestUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Query('limit') limit?: string,
  ) {
    return this.monitors.findChecks(
      user.id,
      id,
      limit ? Number(limit) : undefined,
    );
  }

  @Get(':id/incidents')
  findIncidents(
    @CurrentUser() user: RequestUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Query('limit') limit?: string,
  ) {
    return this.monitors.findIncidents(
      user.id,
      id,
      limit ? Number(limit) : undefined,
    );
  }

  @Patch(':id')
  update(
    @CurrentUser() user: RequestUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateMonitorDto,
  ) {
    return this.monitors.update(user.id, id, dto);
  }

  @Delete(':id')
  @HttpCode(HttpStatus.NO_CONTENT)
  remove(
    @CurrentUser() user: RequestUser,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.monitors.remove(user.id, id);
  }
}
