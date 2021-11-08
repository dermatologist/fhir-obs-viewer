import { ComponentFixture, TestBed } from '@angular/core/testing';

import { SearchParametersComponent } from './search-parameters.component';
import { SearchParametersModule } from './search-parameters.module';
import {
  ConnectionStatus,
  FhirBackendService
} from '../../shared/fhir-backend/fhir-backend.service';
import { configureTestingModule } from 'src/test/helpers';

describe('SearchParametersComponent', () => {
  let component: SearchParametersComponent;
  let fixture: ComponentFixture<SearchParametersComponent>;
  let fhirBackend: FhirBackendService;

  beforeEach(async () => {
    await configureTestingModule({
      declarations: [SearchParametersComponent],
      imports: [SearchParametersModule]
    });
    fhirBackend = TestBed.inject(FhirBackendService);
  });

  beforeEach(() => {
    fixture = TestBed.createComponent(SearchParametersComponent);
    component = fixture.componentInstance;
    fixture.detectChanges();
  });

  it('should create', () => {
    expect(component).toBeTruthy();
  });

  it('should clear the search parameters when connecting to a new server', () => {
    fhirBackend.initialized.next(ConnectionStatus.Ready);
    expect(component.queryCtrl.value.rules.length).toBe(0);
  });

  describe('already selected search parameters', () => {
    let criteria;
    let resourceTypeCriteria;

    beforeEach(() => {
      criteria = component.queryCtrl.value;
      expect(component.selectedElements.size).toBe(0);
      component.addResourceType(criteria);
      resourceTypeCriteria = criteria.rules[0];
    });

    it('should be initialized', () => {
      expect(component.selectedElements.size).toBe(1);
    });

    it('should be updated', () => {
      component.queryBuilderConfig.addRule(resourceTypeCriteria);
      resourceTypeCriteria.rules[0].field = {
        element: 'some-element'
      };
      component.updateSelectedElements(resourceTypeCriteria);
      expect(component.selectedElements.get(resourceTypeCriteria)).toEqual([
        'some-element'
      ]);
    });

    it('should be cleared', () => {
      component.queryBuilderConfig.addRule(resourceTypeCriteria);
      resourceTypeCriteria.rules[0].field = {
        element: 'some-element'
      };
      component.updateSelectedElements(resourceTypeCriteria);
      expect(component.selectedElements.get(resourceTypeCriteria)).toEqual([
        'some-element'
      ]);

      component.queryBuilderConfig.removeRule(
        resourceTypeCriteria.rules[0],
        resourceTypeCriteria
      );
      expect(component.selectedElements.get(resourceTypeCriteria)).toEqual([]);
    });

    it('should be removed', () => {
      component.queryBuilderConfig.removeRule(criteria.rules[0], criteria);
      expect(component.selectedElements.size).toBe(0);
    });
  });
});
