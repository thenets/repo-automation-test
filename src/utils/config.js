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
   * Validate release value against accepted list (supports both single values and arrays)
   */
  validateReleaseValue(value) {
    const accepted = this.getAcceptedReleases();
    
    if (Array.isArray(value)) {
      return value.map(v => ({ value: v, valid: accepted.includes(v) }));
    }
    
    return accepted.includes(value);
  }

  /**
   * Validate backport value against accepted list (supports both single values and arrays)
   */
  validateBackportValue(value) {
    const accepted = this.getAcceptedBackports();
    
    if (Array.isArray(value)) {
      return value.map(v => ({ value: v, valid: accepted.includes(v) }));
    }
    
    return accepted.includes(value);
  }

  /**
   * Get invalid values from validation result
   */
  getInvalidValues(validationResult) {
    if (Array.isArray(validationResult)) {
      return validationResult.filter(item => !item.valid).map(item => item.value);
    }
    return [];
  }

  /**
   * Get valid values from validation result
   */
  getValidValues(validationResult) {
    if (Array.isArray(validationResult)) {
      return validationResult.filter(item => item.valid).map(item => item.value);
    }
    return validationResult ? [validationResult] : [];
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
   * Parse value from YAML content (handles quotes, comments, and arrays)
   */
  parseYamlValue(yamlContent, field) {
    if (!yamlContent) return null;
    
    const regex = new RegExp(`^${field}:\\s*(.+)$`, 'm');
    const match = yamlContent.match(regex);
    
    if (!match) return null;
    
    // Clean the value: remove comments, trim
    const rawValue = match[1].trim()
      .replace(/#.*$/, '') // Remove comments
      .trim();
    
    if (!rawValue) return null;
    
    // Check if it's an array syntax
    if (rawValue.startsWith('[') && rawValue.endsWith(']')) {
      return this.parseYamlArrayValue(rawValue);
    }
    
    // Handle single value - remove quotes
    return rawValue.replace(/^["']|["']$/g, '') || null;
  }

  /**
   * Parse array value from YAML content (handles JSON array syntax with mixed quotes)
   */
  parseYamlArrayValue(arrayString) {
    try {
      // Normalize quotes for JSON parsing - convert single quotes to double quotes
      // but preserve strings that are already properly quoted
      const normalizedString = arrayString.replace(/'([^']*)'/g, '"$1"');
      
      // Parse as JSON array
      const parsed = JSON.parse(normalizedString);
      
      // Ensure it's an array and contains only strings
      if (Array.isArray(parsed)) {
        return parsed.map(item => String(item).trim()).filter(item => item.length > 0);
      }
      
      return null;
    } catch (error) {
      // If JSON parsing fails, return null to indicate invalid array format
      return null;
    }
  }
}

module.exports = { ConfigManager };