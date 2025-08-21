/**
 * Label Automation Module
 * Extracted and modularized logic from:
 * - keeper-auto-label-release-backport.yml
 * - keeper-feature-branch-auto-labeling.yml
 * 
 * Handles:
 * - Release/backport auto-labeling from YAML frontmatter
 * - Feature branch automation based on YAML configuration
 * - YAML validation with check runs and error reporting
 * - Comment cleanup and user feedback
 */

const { ConfigManager } = require('./utils/config');
const { GitHubClient } = require('./utils/github-client');

class LabelAutomation {
  constructor(context, github, options = {}) {
    this.context = context;
    this.github = github;
    this.config = new ConfigManager(context, options);
    this.client = new GitHubClient(github, this.config);
    this.result = {
      labelsAdded: [],
      actions: [],
      checkRuns: []
    };
  }

  /**
   * Main execution function for label automation
   */
  async execute(features) {
    try {
      console.log(`🔖 Starting label automation...`);

      // Get PR data from event
      const prData = await this.extractPRData();
      if (!prData) {
        console.log('ℹ️ No PR data available for label automation');
        return this.result;
      }

      console.log(`🔍 Processing PR #${prData.number}: ${prData.title}`);

      // Skip if PR is draft
      if (prData.draft) {
        console.log('⏭️ Skipping draft pull request');
        return this.result;
      }

      // Parse YAML from PR description
      const yamlContent = this.config.parseYamlFromText(prData.body || '');
      
      if (!yamlContent) {
        console.log('ℹ️ No YAML frontmatter found in PR description');
        
        // Clean up any existing error comments when YAML is completely removed
        if (features.featureBranch) {
          console.log('🧹 Cleaning up feature branch error comments (no YAML found)');
          await this.client.cleanupWorkflowComments(prData.number, '🚨 YAML Validation Error: feature branch');
        }
        
        if (features.releaseLabeling || features.backportLabeling) {
          console.log('🧹 Cleaning up release/backport error comments (no YAML found)');
          await this.client.cleanupWorkflowComments(prData.number, '🚨 YAML Validation Error: release and backport');
        }
        
        return this.result;
      }

      console.log(`📝 Found YAML content in PR description`);

      // Process release/backport labeling if enabled
      if (features.releaseLabeling || features.backportLabeling) {
        await this.processReleaseBackportLabeling(prData, yamlContent, features);
      }

      // Process feature branch labeling if enabled
      if (features.featureBranch) {
        await this.processFeatureBranchLabeling(prData, yamlContent);
      }

      return this.result;

    } catch (error) {
      console.error('❌ Label automation failed:', error.message);
      throw error;
    }
  }

  /**
   * Extract PR data from context (handles both direct PR events and workflow_run)
   */
  async extractPRData() {
    if (this.context.eventName === 'pull_request') {
      // Direct PR event
      return this.context.payload.pull_request;
    } else if (this.context.eventName === 'workflow_run') {
      // workflow_run event - need to find PR by branch
      const workflowRun = this.context.payload.workflow_run;
      const headBranch = workflowRun.head_branch;
      
      if (!headBranch || headBranch === 'main') {
        return null;
      }

      const pr = await this.client.findPRByBranch(headBranch);
      if (!pr || pr.state === 'closed') {
        return null;
      }

      return pr;
    }

    return null;
  }

  /**
   * Process release and backport labeling
   */
  async processReleaseBackportLabeling(prData, yamlContent, features) {
    const prNumber = prData.number;
    const headSha = prData.head.sha;
    let checkRun = null;

    try {
      // Create check run
      checkRun = await this.client.createCheckRun(
        'YAML Validation (Release/Backport)',
        headSha,
        `https://github.com/${this.config.getRepository().owner}/${this.config.getRepository().repo}/actions/runs/${this.context.runId}`
      );

      const validationErrors = [];
      const labelsToAdd = [];

      // Check existing labels to avoid overwriting manual labels
      const currentLabels = await this.client.getLabels(prNumber);
      const hasExistingReleaseLabel = currentLabels.some(label => label.startsWith('release '));
      const hasExistingBackportLabel = currentLabels.some(label => label.startsWith('backport '));

      // Process release labeling
      if (features.releaseLabeling) {
        const releaseResult = await this.processReleaseLabel(yamlContent, hasExistingReleaseLabel);
        if (releaseResult.error) {
          validationErrors.push(releaseResult.error);
        } else if (releaseResult.label) {
          labelsToAdd.push(releaseResult.label);
        }
      }

      // Process backport labeling
      if (features.backportLabeling) {
        const backportResult = await this.processBackportLabel(yamlContent, hasExistingBackportLabel);
        if (backportResult.error) {
          validationErrors.push(backportResult.error);
        } else if (backportResult.label) {
          labelsToAdd.push(backportResult.label);
        }
      }

      // Handle validation errors
      if (validationErrors.length > 0) {
        await this.handleValidationErrors(prNumber, checkRun.data.id, validationErrors);
        return;
      }

      // Clean up previous error comments
      await this.client.cleanupWorkflowComments(prNumber, '🚨 YAML Validation Error: release and backport');

      // Add labels if any
      if (labelsToAdd.length > 0) {
        const result = await this.client.addLabels(prNumber, labelsToAdd);
        this.result.labelsAdded.push(...result.added);
        this.result.actions.push(`Added release/backport labels: ${labelsToAdd.join(', ')}`);

        // Update check run with success
        await this.client.updateCheckRun(checkRun.data.id, 'completed', 'success', {
          title: 'YAML Validation Successful',
          summary: `Successfully validated YAML and added ${labelsToAdd.length} label(s).`,
          text: `**Labels added:**\n${labelsToAdd.map(label => `- \`${label}\``).join('\n')}\n\n**YAML validation passed** - all values are within accepted ranges.`
        });
      } else {
        // Update check run - no labels to add
        await this.client.updateCheckRun(checkRun.data.id, 'completed', 'success', {
          title: 'No YAML Validation Required',
          summary: 'No release/backport labels to add - validation skipped.',
          text: 'This PR does not require any release/backport labels based on the YAML configuration.'
        });
      }

    } catch (error) {
      if (checkRun) {
        await this.client.updateCheckRun(checkRun.data.id, 'completed', 'failure', {
          title: 'Label Assignment Failed',
          summary: 'YAML validation passed but failed to add labels.',
          text: `**Error:** ${error.message}`
        });
      }
      throw error;
    }
  }

  /**
   * Process release label from YAML
   */
  async processReleaseLabel(yamlContent, hasExistingLabel) {
    const releaseValue = this.config.parseYamlValue(yamlContent, 'release');
    
    if (!releaseValue) {
      return { label: null, error: null };
    }

    if (hasExistingLabel) {
      console.log(`Release label already exists, skipping automatic assignment of "release ${releaseValue}"`);
      return { label: null, error: null };
    }

    if (this.config.validateReleaseValue(releaseValue)) {
      console.log(`Found valid release: ${releaseValue}`);
      return { label: `release ${releaseValue}`, error: null };
    } else {
      const acceptedReleases = this.config.getAcceptedReleases();
      return { 
        label: null, 
        error: `❌ Invalid release value: "${releaseValue}". Accepted values: ${acceptedReleases.join(', ')}` 
      };
    }
  }

  /**
   * Process backport label from YAML
   */
  async processBackportLabel(yamlContent, hasExistingLabel) {
    const backportValue = this.config.parseYamlValue(yamlContent, 'backport');
    
    if (!backportValue) {
      return { label: null, error: null };
    }

    if (hasExistingLabel) {
      console.log(`Backport label already exists, skipping automatic assignment of "backport ${backportValue}"`);
      return { label: null, error: null };
    }

    if (this.config.validateBackportValue(backportValue)) {
      console.log(`Found valid backport: ${backportValue}`);
      return { label: `backport ${backportValue}`, error: null };
    } else {
      const acceptedBackports = this.config.getAcceptedBackports();
      return { 
        label: null, 
        error: `❌ Invalid backport value: "${backportValue}". Accepted values: ${acceptedBackports.join(', ')}` 
      };
    }
  }

  /**
   * Process feature branch labeling
   */
  async processFeatureBranchLabeling(prData, yamlContent) {
    const prNumber = prData.number;
    const headSha = prData.head.sha;
    let checkRun = null;

    try {
      // Create check run
      checkRun = await this.client.createCheckRun(
        'YAML Validation (Feature Branch)',
        headSha,
        `https://github.com/${this.config.getRepository().owner}/${this.config.getRepository().repo}/actions/runs/${this.context.runId}`
      );

      // Check if feature-branch label already exists
      const currentLabels = await this.client.getLabels(prNumber);
      const hasFeatureBranchLabel = currentLabels.includes('feature-branch');

      if (hasFeatureBranchLabel) {
        console.log('ℹ️ Feature-branch label already exists, skipping automatic assignment');
        await this.client.cleanupWorkflowComments(prNumber, '🚨 YAML Validation Error: feature branch');
        await this.client.updateCheckRun(checkRun.data.id, 'completed', 'success', {
          title: 'Feature Branch Label Already Present',
          summary: 'Feature-branch label already exists on this PR - skipping automatic assignment.',
          text: 'This PR already has the feature-branch label. Automatic assignment is skipped to preserve manual labeling.'
        });
        return;
      }

      // Parse needs_feature_branch value
      const featureBranchValue = this.config.parseYamlValue(yamlContent, 'needs_feature_branch');
      
      if (!featureBranchValue) {
        console.log('No needs_feature_branch field found in YAML');
        await this.client.cleanupWorkflowComments(prNumber, '🚨 YAML Validation Error: feature branch');
        await this.client.updateCheckRun(checkRun.data.id, 'completed', 'success', {
          title: 'No YAML Validation Required',
          summary: 'No needs_feature_branch field found in YAML code blocks - validation skipped.',
          text: 'This PR does not contain any needs_feature_branch field that needs validation.'
        });
        return;
      }

      // Validate boolean value
      const lowerValue = featureBranchValue.toLowerCase();
      if (lowerValue === 'true') {
        // Add feature-branch label
        const result = await this.client.addLabels(prNumber, ['feature-branch']);
        this.result.labelsAdded.push(...result.added);
        this.result.actions.push(`Added feature-branch label to PR #${prNumber}`);

        await this.client.cleanupWorkflowComments(prNumber, '🚨 YAML Validation Error: feature branch');
        await this.client.updateCheckRun(checkRun.data.id, 'completed', 'success', {
          title: 'YAML Validation Successful',
          summary: 'Successfully validated YAML and added feature-branch label.',
          text: '**Label added:**\n- `feature-branch`\n\n**YAML validation passed** - needs_feature_branch value is valid.'
        });

        console.log('✅ Successfully added feature-branch label');

      } else if (lowerValue === 'false' || lowerValue === '') {
        // Valid false/empty value - no action needed
        console.log('✅ No feature-branch label needed based on YAML configuration');
        await this.client.cleanupWorkflowComments(prNumber, '🚨 YAML Validation Error: feature branch');
        await this.client.updateCheckRun(checkRun.data.id, 'completed', 'success', {
          title: 'YAML Validation Successful',
          summary: 'Successfully validated YAML - no feature-branch label needed.',
          text: '**YAML validation passed** - needs_feature_branch is false or empty, no label added.'
        });

      } else {
        // Invalid value
        const errorMsg = `❌ Invalid needs_feature_branch value: "${featureBranchValue}". Accepted values: true, false (case-insensitive, with optional quotes)`;
        await this.handleFeatureBranchValidationError(prNumber, checkRun.data.id, errorMsg);
      }

    } catch (error) {
      if (checkRun) {
        await this.client.updateCheckRun(checkRun.data.id, 'completed', 'failure', {
          title: 'Workflow Execution Failed',
          summary: 'An unexpected error occurred during workflow execution.',
          text: `**Error:** ${error.message}\n\n**Troubleshooting:**\nCheck the workflow logs for detailed error information.`
        });
      }
      throw error;
    }
  }

  /**
   * Handle validation errors for release/backport
   */
  async handleValidationErrors(prNumber, checkRunId, errors) {
    const acceptedReleases = this.config.getAcceptedReleases();
    const acceptedBackports = this.config.getAcceptedBackports();

    const errorComment = '## 🚨 YAML Validation Error: release and backport\n\n' +
      errors.map(error => `- ${error}`).join('\n') + '\n\n' +
      '### How to fix:\n' +
      '1. Update your PR description YAML block with valid values\n' +
      '2. The workflow will automatically re-run when you edit the description\n\n' +
      '### Valid YAML format:\n' +
      '```yaml\n' +
      `release: 1.5    # Valid releases: ${acceptedReleases.join(', ')}\n` +
      `backport: 1.4   # Valid backports: ${acceptedBackports.join(', ')}\n` +
      '```\n\n' +
      `_This comment was posted by the repository automation workflow._`;

    await this.client.updateCheckRun(checkRunId, 'completed', 'failure', {
      title: 'YAML Validation Failed',
      summary: `Found ${errors.length} validation error(s) in PR description YAML block.`,
      text: errors.map(error => `- ${error}`).join('\n') + '\n\n' +
            '**How to fix:**\n' +
            '1. Update your PR description YAML block with valid values\n' +
            '2. The workflow will automatically re-run when you edit the description\n\n' +
            '**Valid YAML format:**\n' +
            '```yaml\n' +
            `release: 1.5    # Valid releases: ${acceptedReleases.join(', ')}\n` +
            `backport: 1.4   # Valid backports: ${acceptedBackports.join(', ')}\n` +
            '```'
    });

    await this.client.createComment(prNumber, errorComment);
    console.log('💬 Posted validation error comment to PR');
  }

  /**
   * Handle validation errors for feature branch
   */
  async handleFeatureBranchValidationError(prNumber, checkRunId, errorMsg) {
    const errorComment = '## 🚨 YAML Validation Error: feature branch\n\n' +
      `- ${errorMsg}\n\n` +
      '### How to fix:\n' +
      '1. Update your PR description YAML block with valid values\n' +
      '2. The workflow will automatically re-run when you edit the description\n\n' +
      '### Valid YAML format:\n' +
      '```yaml\n' +
      'needs_feature_branch: true    # Valid values: true, false (case-insensitive)\n' +
      'needs_feature_branch: false   # Quotes are optional: "true", \'false\', etc.\n' +
      '```\n\n' +
      `_This comment was posted by the repository automation workflow._`;

    await this.client.updateCheckRun(checkRunId, 'completed', 'failure', {
      title: 'YAML Validation Failed',
      summary: 'Found validation error in PR description YAML block.',
      text: `- ${errorMsg}\n\n` +
            '**How to fix:**\n' +
            '1. Update your PR description YAML block with valid values\n' +
            '2. The workflow will automatically re-run when you edit the description\n\n' +
            '**Valid YAML format:**\n' +
            '```yaml\n' +
            'needs_feature_branch: true    # Valid values: true, false (case-insensitive)\n' +
            'needs_feature_branch: false   # Quotes are optional: "true", \'false\', etc.\n' +
            '```'
    });

    await this.client.createComment(prNumber, errorComment);
    console.log('💬 Posted validation error comment to PR');
  }
}

module.exports = { LabelAutomation };