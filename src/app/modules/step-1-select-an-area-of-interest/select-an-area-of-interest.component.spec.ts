import { ComponentFixture, TestBed } from '@angular/core/testing';
import { SelectAnAreaOfInterestComponent } from './select-an-area-of-interest.component';
import { MockComponent, MockDirective } from 'ng-mocks';
import { ResourceTableComponent } from '../resource-table/resource-table.component';
import { MatLegacyRadioButton as MatRadioButton, MatLegacyRadioGroup as MatRadioGroup } from '@angular/material/legacy-radio';
import { of } from 'rxjs';
import { ReactiveFormsModule } from '@angular/forms';
import { ColumnDescriptionsService } from '../../shared/column-descriptions/column-descriptions.service';
import { MatLegacyCheckbox as MatCheckbox } from '@angular/material/legacy-checkbox';
import { configureTestingModule } from 'src/test/helpers';
import { HttpTestingController } from '@angular/common/http/testing';
import { RouterTestingModule } from '@angular/router/testing';

describe('SelectAnAreaOfInterestComponent', () => {
  let component: SelectAnAreaOfInterestComponent;
  let fixture: ComponentFixture<SelectAnAreaOfInterestComponent>;
  let mockHttp: HttpTestingController;

  beforeEach(async () => {
    await configureTestingModule(
      {
        declarations: [
          SelectAnAreaOfInterestComponent,
          MockDirective(MatRadioGroup),
          MockComponent(MatRadioButton),
          MockComponent(MatCheckbox),
          MockComponent(ResourceTableComponent)
        ],
        imports: [ReactiveFormsModule, RouterTestingModule],
        providers: [
          {
            provide: ColumnDescriptionsService,
            useValue: {
              getVisibleColumns: () => of([]),
              destroy: () => {}
            }
          }
        ]
      },
      {
        definitions: {
          valueSetMapByPath: {
            'ResearchSubject.status': []
          }
        }
      }
    );
    mockHttp = TestBed.inject(HttpTestingController);
  });

  beforeEach(async () => {
    fixture = TestBed.createComponent(SelectAnAreaOfInterestComponent);
    component = fixture.componentInstance;
    await fixture.detectChanges();
  });

  afterEach(() => {
    // Verify that no unmatched requests are outstanding
    mockHttp.verify();
  });

  it('should show table of ResearchStudies', async () => {
    expect(component.showTable).toBeTruthy();
    mockHttp
      .expectOne(
        '$fhir/ResearchStudy?_count=100&_has:ResearchSubject:study:status=&_total=accurate'
      )
      .flush({ entry: [], link: [] });
  });
});
