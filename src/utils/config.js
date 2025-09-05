/**
 * Configuration Management Utilities
 * Handles dynamic repository detection and configuration parsing
 * Supports all repository automation features
 */

class ConfigManager {
  constructor(context, options = {}) {
    this.context = context;
    this.options = options;
    this.owner = context.repo.owner;
    this.repo = context.repo.repo;
    this.repository = `${this.owner}/${this.repo}`;
  }

  /**
   * Get repository information
   */
  getRepository() {
    return {
      owner: this.owner,
      repo: this.repo,
      fullName: this.repository
    };
  }

  /**
   * Check if running in dry-run mode
   */
  isDryRun() {
    return this.options.dryRun === true;
  }

  /**
   * Get the GitHub token to use
   */
  getGithubToken() {
    return this.options.githubToken;
  }

  /**
   * Get accepted release versions
   */
  getAcceptedReleases() {
    return this.options.acceptedReleases || [];
  }

  /**
   * Get accepted backport versions
   */
  getAcceptedBackports() {
    return this.options.acceptedBackports || [];
  }

  /**
   * Check if feature branch automation is enabled
   */
  isFeatureBranchEnabled() {
    return this.options.enableFeatureBranch === true;
  }

  /**
   * Get stale detection days configuration
   */
  getStaleDays() {
    return this.options.staleDays;
  }

  /**
   * Check if release labeling is enabled
   */
  isReleaseLabelingEnabled() {
    return this.getAcceptedReleases().length > 0;
  }

  /**
   * Check if backport labeling is enabled
   */
  isBackportLabelingEnabled() {
    return this.getAcceptedBackports().length > 0;
  }

  /**
   * Check if stale detection is enabled
   */
  isStaleDetectionEnabled() {
    return !!(this.getStaleDays()) || this.context.eventName === 'schedule';
  }

  /**
   * Validate release value against accepted list
   */
  validateReleaseValue(value) {
    const accepted = this.getAcceptedReleases();
    return accepted.includes(value);
  }

  /**
   * Validate backport value against accepted list
   */
  validateBackportValue(value) {
    const accepted = this.getAcceptedBackports();
    return accepted.includes(value);
  }

  /**
   * Log configuration information
   */
  logConfig() {
    console.log(`📋 Configuration:`);
    console.log(`  - Repository: ${this.repository}`);
    console.log(`  - Dry Run: ${this.isDryRun()}`);
    console.log(`  - Token: ${this.getGithubToken() ? '[CONFIGURED]' : '[NOT SET]'}`);
    
    // Log feature configurations
    if (this.isReleaseLabelingEnabled()) {
      console.log(`  - Release Labels: ${this.getAcceptedReleases().join(', ')}`);
    }
    if (this.isBackportLabelingEnabled()) {
      console.log(`  - Backport Labels: ${this.getAcceptedBackports().join(', ')}`);
    }
    if (this.isFeatureBranchEnabled()) {
      console.log(`  - Feature Branch: enabled`);
    }
    if (this.isStaleDetectionEnabled()) {
      console.log(`  - Stale Detection: ${this.getStaleDays()} day(s)`);
    }
  }

  /**
   * Validate that required configuration is present
   */
  validate() {
    if (!this.owner || !this.repo) {
      throw new Error('Repository owner and name are required');
    }
    
    if (!this.getGithubToken()) {
      throw new Error('GitHub token is required');
    }

    // Validate feature-specific configurations
    if (this.isStaleDetectionEnabled() && this.getStaleDays() && this.getStaleDays() < 1) {
      throw new Error('Stale detection days must be 1 or greater');
    }

    return true;
  }

  /**
   * Parse YAML content from text
   */
  parseYamlFromText(text) {
    if (!text) return null;
    
    // Look for YAML code blocks
    const yamlBlockRegex = /```yaml\s*\n([\s\S]*?)\n\s*```/g;
    const matches = [];
    let match;
    
    while ((match = yamlBlockRegex.exec(text)) !== null) {
      matches.push(match[1]);
    }
    
    return matches.length > 0 ? matches[0] : null;
  }

  /**
   * Parse value from YAML content (handles quotes and comments)
   */
  parseYamlValue(yamlContent, field) {
    if (!yamlContent) return null;
    
    const regex = new RegExp(`^${field}:\\s*(.+)$`, 'm');
    const match = yamlContent.match(regex);
    
    if (!match) return null;
    
    // Clean the value: remove comments, trim, remove quotes
    const rawValue = match[1].trim()
      .replace(/#.*$/, '') // Remove comments
      .trim()
      .replace(/^["']|["']$/g, ''); // Remove surrounding quotes
    
    return rawValue || null;
  }
}

module.exports = { ConfigManager };