import { Body, Controller, Post } from '@nestjs/common';

import { MiningAuthzService } from '../../services/mining-authz.service';

/**
 * Pool-side proxy for the new device-class endpoints (per device-class
 * plan P-2b). Firmware calls /api/policy and /api/ota/report against the
 * pool URL it already uses for /api/activation/*; pool forwards verbatim
 * to backend's /v1/device/policy and /v1/device/ota/report. The backend
 * HMAC challenge-response is the only auth on the body — the proxy
 * layer doesn't add or strip anything.
 *
 * Routes:
 *   POST /api/policy     -> backend POST /v1/device/policy       (B-9)
 *   POST /api/ota/report -> backend POST /v1/device/ota/report   (B-10)
 */
@Controller()
export class DevicePolicyController {
  constructor(private readonly miningAuthzService: MiningAuthzService) {}

  @Post('policy')
  public async fetchPolicy(@Body() body: Record<string, unknown>) {
    return this.miningAuthzService.fetchDevicePolicy(body);
  }

  @Post('ota/report')
  public async reportOta(@Body() body: Record<string, unknown>) {
    return this.miningAuthzService.reportDeviceOta(body);
  }
}
