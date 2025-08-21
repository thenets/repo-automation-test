/**
 * Repository Automation Orchestrator
 * Main entry point for all repository automation features
 * 
 * Core Features (always enabled):
 * - Auto-add triage labels to new issues
 * - Smart PR labeling (triage vs ready-for-review based on release labels)
 * - Triage label protection (re-add if removed without release/backport labels)
 * - Fork compatibility through workflow_run events
 * 
 * Optional Features (enabled by inputs):
 * - Release/backport auto-labeling (when accepted-releases/accepted-backports provided)
 * - Feature branch automation (when enable-feature-branch is true)
 * - Stale PR detection (when stale-days provided or schedule event)
 */

const { ConfigManager } = require('./utils/config');
const { GitHubClient } = require('./utils/github-client');

class RepositoryAutomation {
  constructor(context, github, options = {}) {
    this.context = context;
    this.github = github;
    this.config = new ConfigManager(context, options);
    this.client = new GitHubClient(github, this.config);
    this.result = {
      labelsAdded: [],
      summary: '',
      actions: [],
      featuresEnabled: []
    };
    
    // Detect enabled features based on inputs
    this.features = this.detectEnabledFeatures();
  }

  /**
   * Detect which features are enabled based on provided inputs
   */
  detectEnabledFeatures() {
    const options = this.config.options;
    
    const features = {
      triage: true, // Always enabled (core functionality)
      releaseLabeling: !!(options.acceptedReleases && options.acceptedReleases.length > 0),
      backportLabeling: !!(options.acceptedBackports && options.acceptedBackports.length > 0),
      featureBranch: options.enableFeatureBranch === true,
      staleDetection: !!(options.staleDays) || this.context.eventName === 'schedule'
    };
    
    // Log enabled features
    const enabledFeatures = Object.keys(features).filter(f => features[f]);
    console.log(`🎯 Enabled features: ${enabledFeatures.join(', ')}`);
    
    return features;
  }

  /**
   * Main execution function - orchestrates all enabled features
   */
  async execute() {
    try {
      this.config.validate();
      this.config.logConfig();

      console.log(`🔄 Starting repository automation for event: ${this.context.eventName}`);
      
      // Store enabled features in result
      this.result.featuresEnabled = Object.keys(this.features).filter(f => this.features[f]);

      // Always run core triage automation
      await this.executeTriageAutomation();
      
      // Run optional features based on inputs and event types
      if (this.features.releaseLabeling || this.features.backportLabeling || this.features.featureBranch) {
        await this.executeLabelAutomation();
      }
      
      if (this.features.staleDetection) {
        await this.executeStaleDetection();
      }

      return this.result;

    } catch (error) {
      console.error('❌ Repository automation failed:', error.message);
      this.result.summary = `Failed: ${error.message}`;
      throw error;
    }
  }

  /**
   * Execute core triage automation (always runs)
   */
  async executeTriageAutomation() {
    console.log('🏷️ Executing core triage automation...');
    
    // Handle different event types for triage
    if (this.context.eventName === 'issues') {
      await this.handleIssueEvent();
    } else if (this.context.eventName === 'workflow_run') {
      await this.handleWorkflowRunEvent();
    } else if (this.context.eventName === 'pull_request') {
      // Direct PR events (when not using workflow_run pattern)
      const prData = this.context.payload.pull_request;
      await this.handlePullRequestEvent(prData);
    } else {
      console.log(`ℹ️ Event type ${this.context.eventName} not handled by triage automation`);
    }
  }

  /**
   * Execute label automation features (release/backport/feature-branch)
   */
  async executeLabelAutomation() {
    console.log('🔖 Executing label automation...');
    
    try {
      // Only process pull_request or workflow_run events for label automation
      if (this.context.eventName === 'pull_request' || this.context.eventName === 'workflow_run') {
        // Import label automation module when needed
        const { LabelAutomation } = require('./label-automation');
        const labelAutomation = new LabelAutomation(this.context, this.github, this.config.options);
        
        const labelResult = await labelAutomation.execute(this.features);
        
        // Merge results
        this.result.labelsAdded.push(...(labelResult.labelsAdded || []));
        this.result.actions.push(...(labelResult.actions || []));
      }
    } catch (error) {
      if (error.code === 'MODULE_NOT_FOUND') {
        console.log('ℹ️ Label automation module not yet implemented, skipping...');
      } else {
        throw error;
      }
    }
  }

  /**
   * Execute stale detection feature
   */
  async executeStaleDetection() {
    console.log('⏰ Executing stale detection...');
    
    try {
      // Only run stale detection on schedule events or when explicitly requested
      if (this.context.eventName === 'schedule' || this.features.staleDetection) {
        // Import stale detection module when needed
        const { StaleDetection } = require('./stale-detection');
        const staleDetection = new StaleDetection(this.context, this.github, this.config.options);
        
        const staleResult = await staleDetection.execute();
        
        // Merge results
        this.result.labelsAdded.push(...(staleResult.labelsAdded || []));
        this.result.actions.push(...(staleResult.actions || []));
      }
    } catch (error) {
      if (error.code === 'MODULE_NOT_FOUND') {
        console.log('ℹ️ Stale detection module not yet implemented, skipping...');
      } else {
        throw error;
      }
    }
  }

  /**
   * Handle issues.opened events
   */
  async handleIssueEvent() {
    if (this.context.payload.action !== 'opened') {
      console.log(`ℹ️ Issue action ${this.context.payload.action} not handled`);
      return;
    }

    const issueNumber = this.context.issue.number;
    console.log(`🎯 Processing new issue #${issueNumber}`);

    try {
      const result = await this.client.addLabels(issueNumber, ['triage']);
      
      if (result.added.length > 0) {
        this.result.labelsAdded.push(...result.added);
        this.result.actions.push(`Added triage label to issue #${issueNumber}`);
      }
      
      this.result.summary = `Successfully processed issue #${issueNumber}`;
      
    } catch (error) {
      this.result.summary = `Failed to process issue #${issueNumber}: ${error.message}`;
      throw error;
    }
  }

  /**
   * Handle workflow_run events (for fork compatibility)
   */
  async handleWorkflowRunEvent() {
    const workflowRun = this.context.payload.workflow_run;
    
    if (workflowRun.conclusion !== 'success') {
      console.log(`ℹ️ Workflow run conclusion was ${workflowRun.conclusion}, skipping`);
      return;
    }

    console.log(`🔄 Processing workflow_run from: ${workflowRun.name}`);
    
    const headBranch = workflowRun.head_branch;
    console.log(`📋 Head branch: ${headBranch}`);

    if (!headBranch || headBranch === 'main') {
      console.log('ℹ️ Workflow was not triggered by a PR branch, skipping');
      return;
    }

    // Find the PR associated with this branch
    const pr = await this.client.findPRByBranch(headBranch);
    
    if (!pr) {
      console.log(`ℹ️ No PR found for branch ${headBranch}`);
      return;
    }

    console.log(`🎯 Found PR #${pr.number}: ${pr.title} (state: ${pr.state})`);

    // Skip if PR is closed
    if (pr.state === 'closed') {
      console.log(`ℹ️ PR #${pr.number} is closed, skipping labeling`);
      return;
    }

    await this.handlePullRequestEvent(pr);
  }

  /**
   * Handle pull request events with smart labeling logic
   */
  async handlePullRequestEvent(prData) {
    const prNumber = prData.number;
    
    // Skip draft PRs
    if (prData.draft) {
      console.log(`ℹ️ PR #${prNumber} is draft, skipping labeling`);
      return;
    }

    // Add 10-second delay as requested in original workflow
    console.log('⏳ Sleeping for 10 seconds...');
    if (!this.config.isDryRun()) {
      await new Promise(resolve => setTimeout(resolve, 10000));
    }

    try {
      // Get current labels on the PR
      const currentLabels = await this.client.getLabels(prNumber);
      console.log(`📋 Current labels on PR #${prNumber}: ${currentLabels.join(', ')}`);

      // Check label conditions
      const labelChecks = await this.client.hasLabels(prNumber, [
        'release *',
        'backport *', 
        'triage',
        'ready for review'
      ]);

      const hasReleaseLabel = labelChecks['release *'];
      const hasBackportLabel = labelChecks['backport *'];
      const hasTriageLabel = labelChecks['triage'];
      const hasReadyForReviewLabel = labelChecks['ready for review'];

      // Also check for release content in YAML (for cases where the release label hasn't been added yet)
      const yamlContent = this.config.parseYamlFromText(prData.body || '');
      const hasReleaseYaml = yamlContent && this.config.parseYamlValue(yamlContent, 'release');
      const hasBackportYaml = yamlContent && this.config.parseYamlValue(yamlContent, 'backport');

      console.log(`🔍 Label analysis:`);
      console.log(`  - Has release label: ${hasReleaseLabel}`);
      console.log(`  - Has backport label: ${hasBackportLabel}`);
      console.log(`  - Has triage label: ${hasTriageLabel}`);
      console.log(`  - Has ready for review label: ${hasReadyForReviewLabel}`);
      console.log(`  - Has release YAML: ${!!hasReleaseYaml}`);
      console.log(`  - Has backport YAML: ${!!hasBackportYaml}`);
      console.log(`  - Is draft: ${prData.draft}`);

      // Main logic: If PR has release label/YAML and not draft, add ready for review; otherwise add triage
      if ((hasReleaseLabel || hasReleaseYaml) && !prData.draft) {
        await this.handleReadyForReviewLabel(prNumber, hasReadyForReviewLabel);
      } else if (!hasBackportLabel && !hasBackportYaml) {
        await this.handleTriageLabel(prNumber, hasTriageLabel, hasReleaseLabel || !!hasReleaseYaml);
      } else {
        console.log(`ℹ️ PR #${prNumber} has backport label/YAML, skipping automatic labeling`);
      }

    } catch (error) {
      this.result.summary = `Failed to process PR #${prNumber}: ${error.message}`;
      throw error;
    }
  }

  /**
   * Handle adding ready-for-review label
   */
  async handleReadyForReviewLabel(prNumber, hasLabel) {
    if (!hasLabel) {
      const result = await this.client.addLabels(prNumber, ['ready for review']);
      
      if (result.added.length > 0) {
        this.result.labelsAdded.push(...result.added);
        this.result.actions.push(`Added "ready for review" label to PR #${prNumber} (has release label, not draft)`);
      }
    } else {
      console.log(`ℹ️ PR #${prNumber} already has "ready for review" label`);
    }
  }

  /**
   * Handle adding triage label
   */
  async handleTriageLabel(prNumber, hasLabel, hasReleaseLabel) {
    if (!hasLabel) {
      const result = await this.client.addLabels(prNumber, ['triage']);
      
      if (result.added.length > 0) {
        this.result.labelsAdded.push(...result.added);
        
        const reason = !hasReleaseLabel ? 
          'no release/backport label' : 
          'is draft';
        this.result.actions.push(`Added triage label to PR #${prNumber} (${reason})`);
      }
    } else {
      console.log(`ℹ️ PR #${prNumber} already has triage label`);
    }
  }

  /**
   * Handle triage protection (re-add if removed without release/backport labels)
   * This would be called for labeled/unlabeled events
   */
  async handleTriageProtection(issueNumber, eventType = 'PR') {
    console.log(`🛡️ Triage label removed from ${eventType} #${issueNumber}, checking for protection conditions`);

    try {
      const labelChecks = await this.client.hasLabels(issueNumber, ['release *', 'backport *']);
      const hasReleaseLabel = labelChecks['release *'];
      const hasBackportLabel = labelChecks['backport *'];

      // If no release or backport labels, re-add triage label
      if (!hasReleaseLabel && !hasBackportLabel) {
        const result = await this.client.addLabels(issueNumber, ['triage']);
        
        if (result.added.length > 0) {
          this.result.labelsAdded.push(...result.added);
          this.result.actions.push(`Re-added triage label to ${eventType} #${issueNumber} (no release/backport labels found)`);
        }
        
        console.log(`✅ Re-added triage label to ${eventType} #${issueNumber} (no release/backport labels found)`);
      } else {
        console.log(`ℹ️ Triage label removal allowed for ${eventType} #${issueNumber} (release/backport labels present)`);
      }
    } catch (error) {
      this.result.summary = `Failed to handle triage protection for ${eventType} #${issueNumber}: ${error.message}`;
      throw error;
    }
  }
}

/**
 * Main execute function for the action
 */
async function execute(context, github, options = {}) {
  const automation = new RepositoryAutomation(context, github, options);
  const result = await automation.execute();
  
  // Generate summary
  if (result.actions.length > 0) {
    result.summary = `Completed ${result.actions.length} action(s): ${result.actions.join('; ')}`;
  } else {
    result.summary = result.summary || 'No actions needed';
  }
  
  console.log(`✅ Repository automation completed successfully`);
  console.log(`📋 Features enabled: ${result.featuresEnabled.join(', ')}`);
  console.log(`📋 Summary: ${result.summary}`);
  
  return result;
}

module.exports = { RepositoryAutomation, execute };