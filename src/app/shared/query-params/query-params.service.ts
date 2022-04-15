import { Injectable } from '@angular/core';
import { SearchParameter } from '../../types/search.parameter';
import { encodeFhirSearchParameter, escapeFhirSearchParameter } from '../utils';
import { FhirBackendService } from '../fhir-backend/fhir-backend.service';

export const CODETEXT = 'code text';
export const OBSERVATION_VALUE = 'observation value';
export const CODETYPES = ['code', 'CodeableConcept', 'Coding'];

@Injectable({
  providedIn: 'root'
})
export class QueryParamsService {
  private get definitions(): any {
    return this.fhirBackend.getCurrentDefinitions();
  }

  constructor(private fhirBackend: FhirBackendService) {}

  /**
   * Returns string of url segment describing the search criteria that will be used to search in server.
   * @param resourceType - resource type
   * @param value - search parameter value
   */
  getQueryParam(resourceType: string, value: SearchParameter): string {
    if (resourceType === 'EvidenceVariable') {
      return `&evidencevariable=${this.getEvidenceVariableIds(value)}`;
    }
    const selectedParameter = this.definitions.resources[
      resourceType
    ]?.searchParameters.find((p) => p.element === value?.element);
    // If it is not a search parameter
    // (e.g. element === '_has:ResearchSubject:individual:study'),
    // use the default template
    if (!selectedParameter) {
      return `&${value.element}=${value.value}`;
    }
    if (selectedParameter.element === CODETEXT) {
      if (resourceType === 'Observation') {
        return this.getObservationCodeTextCriteria(value);
      } else {
        const usedCodes = {};
        const codes = value.value.codes.filter((code) => {
          if (!code || usedCodes[code]) {
            return false;
          }
          return (usedCodes[code] = true);
        });
        return codes.length ? `&code=${codes.join(',')}` : '';
      }
    }
    if (selectedParameter.element === OBSERVATION_VALUE) {
      return this.getObservationValueCriteria(value);
    }
    if (selectedParameter.type === 'date') {
      return (
        (value.value.from
          ? `&${selectedParameter.element}=ge${value.value.from}`
          : '') +
        (value.value.to
          ? `&${selectedParameter.element}=le${value.value.to}`
          : '')
      );
    }
    if (
      resourceType === 'Patient' &&
      selectedParameter.element === 'active' &&
      value.value === 'true'
    ) {
      // Include patients with active field not defined when searching active patients
      return '&active:not=false';
    }
    if (this.getUseLookupParamValue(selectedParameter)) {
      return `&${selectedParameter.element}=${value.value.codes.join(',')}`;
    }
    if (selectedParameter.type === 'Quantity') {
      const testValueCriteria = this.getCompositeTestValueCriteria(
        selectedParameter.type,
        value.value
      );
      return testValueCriteria
        ? `&${selectedParameter.element}${testValueCriteria}`
        : '';
    }
    return `&${selectedParameter.element}=${value.value}`;
  }

  /**
   * Returns comma separated list of EV full URLs, to be used as query param
   * for the EV search parameter.
   * @param value search parameter value
   * @private
   */
  private getEvidenceVariableIds(value: SearchParameter): string {
    return value.value.codes
      .map((codes: string[]) =>
        codes
          .map(
            (c) => `${this.fhirBackend.serviceBaseUrl}/EvidenceVariable/${c}`
          )
          .join(',')
      )
      .join(',');
  }

  /**
   * Get criteria string for Observation "code text" parameter
   */
  private getObservationCodeTextCriteria(value: SearchParameter): string {
    const selectedCodes = value.selectedObservationCodes;
    // Ignore criteria if no code selected.
    if (!selectedCodes) {
      return '';
    }
    const usedCodes = {};
    const coding = selectedCodes.coding.filter((c) => {
      if (!c || usedCodes[c.code]) {
        return false;
      }
      return (usedCodes[c.code] = true);
    });
    return coding.length
      ? '&combo-code=' +
          coding.map((code) => encodeFhirSearchParameter(code.code)).join(',')
      : '';
  }

  /**
   * Get criteria string for "observation value" parameter
   */
  private getObservationValueCriteria(value: SearchParameter): string {
    const valueParamName =
      {
        CodeableConcept: 'combo-value-concept',
        Quantity: 'combo-value-quantity',
        string: 'value-string'
      }[value.observationDataType] || 'combo-value-quantity';
    const testValueCriteria = this.getCompositeTestValueCriteria(
      value.observationDataType,
      value.value
    );
    return testValueCriteria ? `&${valueParamName}${testValueCriteria}` : '';
  }

  /**
   * Get criteria string for composite test value controls
   * e.g. prefix + value + unit
   */
  private getCompositeTestValueCriteria(datatype: string, value: any): string {
    if (datatype === 'CodeableConcept') {
      return (
        '=' +
        (value.testValue?.codes || [])
          .map((code) => escapeFhirSearchParameter(code))
          .join(',')
      );
    }
    const modifier = value.testValueModifier;
    const prefix = value.testValuePrefix;
    const testValue = value.testValue
      ? escapeFhirSearchParameter(value.testValue.toString())
      : '';
    const unit = value.testValueUnit;
    return testValue.trim()
      ? `${modifier}=${prefix}${encodeURIComponent(
          testValue + (unit ? '||' + escapeFhirSearchParameter(unit) : '')
        )}`
      : '';
  }

  /**
   * Whether to use lookup control for search parameter value.
   */
  getUseLookupParamValue(selectedParameter: any): boolean {
    return CODETYPES.includes(selectedParameter.type);
  }
}
