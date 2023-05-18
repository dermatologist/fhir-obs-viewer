import { AfterViewInit, Component, ViewChild } from '@angular/core';
import pkg from '../../../../package.json';
import { setUrlParam } from '../../shared/utils';
import { RasTokenService } from '../../shared/ras-token/ras-token.service';
import { StepperComponent, Step } from '../stepper/stepper.component';
import { CreateCohortMode } from '../../shared/cohort/cohort.service';
import { FhirBackendService } from '../../shared/fhir-backend/fhir-backend.service';
import { LiveAnnouncer } from '@angular/cdk/a11y';

@Component({
  selector: 'app-home',
  templateUrl: './home.component.html',
  styleUrls: ['./home.component.less']
})
export class HomeComponent implements AfterViewInit {
  version = pkg.version;
  @ViewChild(StepperComponent) stepperComponent: StepperComponent;

  constructor(
    public rasToken: RasTokenService,
    public fhirBackend: FhirBackendService,
    private liveAnnouncer: LiveAnnouncer
  ) {}

  openChangelog(): void {
    window.open(
      'https://github.com/lhncbc/fhir-obs-viewer/blob/master/CHANGELOG.md',
      '_blank',
      'noopener noreferrer'
    );
  }

  /**
   * Switch between 'alpha' and stable versions of the app.
   * Log out of RAS if it was logged in when switching.
   */
  switchVersion(): void {
    if (this.rasToken.rasTokenValidated) {
      this.rasToken.logout().then(() => {
        this.setVersionUrlParam();
      });
    } else {
      this.setVersionUrlParam();
    }
  }

  /**
   * Update the url 'alpha-version' parameter.
   * Called when switching alpha version on/off.
   * @private
   */
  private setVersionUrlParam(): void {
    window.location.href = setUrlParam(
      'alpha-version',
      this.fhirBackend.isAlphaVersion ? 'disable' : 'enable'
    );
  }

  onRasLogout(): void {
    this.rasToken.logout().then(() => {
      this.stepperComponent.stepper.selectedIndex = Step.SETTINGS;
      this.stepperComponent.selectAnActionComponent.createCohortMode.setValue(
        CreateCohortMode.UNSELECTED
      );
      this.liveAnnouncer.announce('Logged out. Returning to settings page.');
    });
  }

  onSmartLogout(): void {
    window.history.pushState({}, '', setUrlParam('isSmart', 'false'));
    this.fhirBackend.isSmartOnFhir = false;
    this.liveAnnouncer.announce('Logged out from SMART on FHIR connection.');
  }

  ngAfterViewInit(): void {
    // Display shared header/footer after Angular page loads.
    document.getElementById('sharedHeader').style.display = 'block';
    document.getElementById('sharedFooter').style.display = 'block';
  }
}
