import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { ListingsAdminController } from './controllers/listings.admin.controller';
import { ListingsController } from './controllers/listings.controller';
import { ListingsInternalController } from './controllers/listings.internal.controller';
import { LocationsController } from './controllers/locations.controller';
import { City } from './entities/city.entity';
import { District } from './entities/district.entity';
import { ListingImage } from './entities/listing-image.entity';
import { Listing } from './entities/listing.entity';
import { ListingCommandService } from './services/listing-command.service';
import { ListingHoldService } from './services/listing-hold.service';
import { ListingImageService } from './services/listing-image.service';
import { ListingQueryService } from './services/listing-query.service';
import { ListingReviewService } from './services/listing-review.service';
import { ListingPresenter } from './services/listing.presenter';
import { LocationQueryService } from './services/location-query.service';

/**
 * Nghiệp vụ của listing-service (ADR-0010: sản phẩm và tin đăng là một bản ghi). Chỉ được nạp khi có
 * DB và S3 (xem app.module.ts và isListingEnabled()). Listing không phát, không nghe sự kiện.
 *
 * T2.3: tìm kiếm PostGIS và `snapshot` ở `ListingQueryService`, `ListingHoldService` (giữ chỗ, đổi trạng
 * thái theo đơn) và `ListingsInternalController` (/internal/listings/*, chỉ rental gọi).
 *
 * T2.6: danh mục tỉnh/thành, quận/huyện (`RE.LOCATION`): `LocationsController` (/cities, /districts,
 * công khai) và `LocationQueryService` (cũng dùng để kiểm cặp `cityId`/`districtId` khi tạo, sửa tin).
 */
@Module({
  imports: [TypeOrmModule.forFeature([Listing, ListingImage, City, District])],
  controllers: [
    ListingsController,
    ListingsAdminController,
    ListingsInternalController,
    LocationsController,
  ],
  providers: [
    ListingPresenter,
    ListingCommandService,
    ListingQueryService,
    ListingReviewService,
    ListingImageService,
    ListingHoldService,
    LocationQueryService,
  ],
})
export class ListingModule {}
