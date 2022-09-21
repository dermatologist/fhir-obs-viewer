import { Component } from '@angular/core';
import {
  FormBuilder,
  FormControl,
  FormGroup,
  ValidationErrors,
  Validators
} from '@angular/forms';
import {
  ConnectionStatus,
  FhirBackendService
} from '../../shared/fhir-backend/fhir-backend.service';
import { Observable } from 'rxjs';
import { filter, map, take } from 'rxjs/operators';
import { setUrlParam } from '../../shared/utils';

/**
 * Settings page component for defining general parameters such as FHIR REST API Service Base URL.
 */
@Component({
  selector: 'app-settings-page',
  templateUrl: './settings-page.component.html',
  styleUrls: ['./settings-page.component.less']
})
export class SettingsPageComponent {
  settingsFormGroup: FormGroup;
  isWaitingForConnection: Observable<boolean>;
  isSmartConnectionSuccess: Observable<boolean>;

  constructor(
    private formBuilder: FormBuilder,
    public fhirBackend: FhirBackendService
  ) {
    this.isWaitingForConnection = fhirBackend.initialized.pipe(
      map((status) => status === ConnectionStatus.Pending)
    );
    this.isSmartConnectionSuccess = fhirBackend.initialized.pipe(
      map((status) => status === ConnectionStatus.SmartConnectionSuccess)
    );
    this.settingsFormGroup = this.formBuilder.group({
      serviceBaseUrl: new FormControl(this.fhirBackend.serviceBaseUrl, {
        validators: Validators.required,
        asyncValidators: this.serviceBaseUrlValidator.bind(this)
      }),
      apiKey: [''],
      maxRequestsPerBatch: [
        this.fhirBackend.maxRequestsPerBatch,
        Validators.required
      ],
      maxActiveRequests: [
        this.fhirBackend.maxActiveRequests,
        Validators.required
      ],
      cacheDisabled: [!this.fhirBackend.cacheEnabled]
    });
    this.settingsFormGroup
      .get('serviceBaseUrl')
      .statusChanges.pipe(filter((s) => s === 'VALID'))
      .subscribe(() => {
        const server = this.settingsFormGroup.get('serviceBaseUrl').value;
        // Update url query params after valid server change
        window.history.pushState({}, '', setUrlParam('server', server));
      });
    if (this.fhirBackend.isSmartOnFhir) {
      this.fhirBackend.initializeSmartOnFhirConnection();
    }
  }

  /**
   * Update FHIR REST API Service configuration parameter from input field by name.
   * @param name - parameter name
   * @param value - parameter value
   */
  updateFhirBackendSetting(name: string, value?: any): void {
    const newValue =
      value !== undefined ? value : this.settingsFormGroup.get(name).value;
    this.fhirBackend[name] = newValue;
  }

  /**
   * Updates and validates the server base URL
   * @param control - FormControl instance associated with the input field
   */
  serviceBaseUrlValidator(
    control: FormControl
  ): Observable<ValidationErrors | null> {
    // Update serverBaseUrl (ignore trailing backslashes)
    this.fhirBackend.serviceBaseUrl = control.value.replace(/\/+$/, '');

    // Wait for response to validate server
    return this.fhirBackend.initialized.pipe(
      filter((status) => status !== ConnectionStatus.Pending),
      take(1),
      map((status) => {
        this.settingsFormGroup
          .get('maxRequestsPerBatch')
          .setValue(this.fhirBackend.maxRequestsPerBatch);
        this.settingsFormGroup
          .get('maxActiveRequests')
          .setValue(this.fhirBackend.maxActiveRequests);
        return status === ConnectionStatus.SmartConnectionFailure
          ? { smartConnectionFailure: true }
          : status === ConnectionStatus.Error
          ? { wrongUrl: true }
          : null;
      })
    );
  }
}
