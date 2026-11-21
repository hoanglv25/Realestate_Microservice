import { HttpModule } from '@nestjs/axios';
import { Global, Module } from '@nestjs/common';
import { InternalHttpService } from './internal-http.service';

/** Global để mọi module inject InternalHttpService mà không cần import lại. */
@Global()
@Module({
  imports: [HttpModule],
  providers: [InternalHttpService],
  exports: [InternalHttpService],
})
export class InternalHttpModule {}
