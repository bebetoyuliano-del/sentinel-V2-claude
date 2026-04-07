import { ParityAdapter } from './ParityAdapter';

export class ScenarioRunner {
  static run(fixture: any): any {
    // 1. Build input state from fixture
    const inputState = fixture.input_state;
    
    // 2. Run one step of evaluation (via adapter)
    const result = ParityAdapter.evaluate(inputState);
    
    // 3. Capture outputs
    return {
      scenario_id: fixture.scenario_id,
      final_action: result.final_action,
      fallback_action: result.fallback_action,
      blocked_actions: result.blocked_actions,
      actual_post_state: result.actual_post_state,
      why_blocked: result.why_blocked,
      why_allowed: result.why_allowed,
      audit_trail: result.audit_trail
    };
  }
}
