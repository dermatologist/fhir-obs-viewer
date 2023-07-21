import { Component, OnDestroy } from '@angular/core';
import {
  UntypedFormBuilder,
  UntypedFormControl,
  UntypedFormGroup,
  ValidationErrors,
  Validators
} from '@angular/forms';
import {
  ConnectionStatus,
  FhirBackendService
} from '../../shared/fhir-backend/fhir-backend.service';
import { fromEvent, Observable, Subscription } from 'rxjs';
import { filter, map, take } from 'rxjs/operators';
import { setUrlParam } from '../../shared/utils';
import { LiveAnnouncer } from '@angular/cdk/a11y';
import { MatDialog, MatDialogRef } from '@angular/material/dialog';
import { AlertDialogComponent } from '../../shared/alert-dialog/alert-dialog.component';

/**
 * Settings page component for defining general parameters such as FHIR REST API Service Base URL.
 */
@Component({
  selector: 'app-settings-page',
  templateUrl: './settings-page.component.html',
  styleUrls: ['./settings-page.component.less']
})
export class SettingsPageComponent implements OnDestroy {
  settingsFormGroup: UntypedFormGroup;
  // Subscription to the "batch-issue" event dispatched by FhirBatchQuery
  subscription: Subscription;
  // Reference to the dialog about problems with batch requests
  dialogRef: MatDialogRef<AlertDialogComponent>;

  constructor(
    private formBuilder: UntypedFormBuilder,
    public fhirBackend: FhirBackendService,
    private liveAnnouncer: LiveAnnouncer,
    private dialog: MatDialog
  ) {
    this.settingsFormGroup = this.formBuilder.group({
      serviceBaseUrl: new UntypedFormControl(this.fhirBackend.serviceBaseUrl, {
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
        if (!this.fhirBackend.isSmartOnFhir) {
          const server = this.settingsFormGroup.get('serviceBaseUrl').value;
          // Update url query params after valid server change
          window.history.pushState(
            {},
            '',
            setUrlParam('isSmart', 'false', setUrlParam('server', server))
          );
        }
      });

    this.subscription = fromEvent(
      this.fhirBackend.fhirClient,
      'batch-issue'
    ).subscribe(() => this.showBatchIssueDialog());
  }

  /**
   * Performs cleanup when a component instance is destroyed.
   */
  ngOnDestroy(): void {
    this.subscription.unsubscribe();
  }

  /**
   * Displays a dialog about problems with batch requests.
   */
  showBatchIssueDialog(): void {
    if (!this.dialogRef) {
      this.dialogRef = this.dialog.open(AlertDialogComponent, {
        data: {
          header: 'Disable batch requests?',
          content:
            'We are experiencing problems with batch requests.' +
            ' Disabling them may improve performance.' +
            " Currently, if a batch request doesn't work, we try to resend the requests separately." +
            ' You can also reduce the number of requests per batch in the settings step.',
          hasCancelButton: true
        }
      });
      this.dialogRef.afterClosed().subscribe((isOk) => {
        if (isOk) {
          this.settingsFormGroup.get('maxRequestsPerBatch').setValue(1);
          this.updateFhirBackendSetting('maxRequestsPerBatch');
        }
        this.dialogRef = null;
      });
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
   * @returns validation error for service base URL, or null if valid
   */
  serviceBaseUrlValidator(
    control: UntypedFormControl
  ): Observable<ValidationErrors | null> {
    // Update serverBaseUrl (ignore trailing backslashes)
    this.fhirBackend.serviceBaseUrl = control.value.replace(/\/+$/, '');

    // Wait for response to validate server
    return this.fhirBackend.initialized.pipe(
      filter((status) => status !== ConnectionStatus.Pending),
      take(1),
      map((status) => {
        if (!this.fhirBackend.isSmartOnFhir) {
          this.settingsFormGroup
            .get('maxRequestsPerBatch')
            .setValue(this.fhirBackend.maxRequestsPerBatch);
          this.settingsFormGroup
            .get('maxActiveRequests')
            .setValue(this.fhirBackend.maxActiveRequests);
        }
        this.liveAnnouncer.clear();
        if (status === ConnectionStatus.Error) {
          if (this.fhirBackend.isSmartOnFhir) {
            this.liveAnnouncer.announce('SMART on FHIR connection failed.');
            return { smartConnectionFailure: true };
          } else {
            this.liveAnnouncer.announce(
              'Please specify a valid FHIR server URL.'
            );
            return { wrongUrl: true };
          }
        } else if (status === ConnectionStatus.UnsupportedVersion) {
          this.liveAnnouncer.announce('Unsupported FHIR version.');
          return { unsupportedVersion: true };
        } else {
          if (status === ConnectionStatus.Ready) {
            this.liveAnnouncer.announce('Initialization complete.');
          }
          return null;
        }
      })
    );
  }
}
