import { Component, OnInit } from '@angular/core';
import { Router } from '@angular/router';
import { RasTokenService } from '../../shared/ras-token/ras-token.service';
import { FhirBackendService } from '../../shared/fhir-backend/fhir-backend.service';

@Component({
  selector: 'app-ras-token-callback',
  templateUrl: 'ras-token-callback.component.html'
})
export class RasTokenCallbackComponent implements OnInit {
  constructor(
    private router: Router,
    private rasToken: RasTokenService,
    private fhirBackend: FhirBackendService
  ) {}
  ngOnInit(): void {
    // TODO: actually validate RAS token in RasTokenService.
    this.rasToken.rasTokenValidated = true;
    this.fhirBackend.serviceBaseUrl = sessionStorage.getItem(
      'dbGapRasLoginServer'
    );
    this.router.navigate(['/'], {
      queryParams: {
        'alpha-version': 'enable',
        server: this.fhirBackend.serviceBaseUrl
      }
    });
  }
}