/**
 * Stale Detection Module
 * Extracted and modularized logic from keeper-stale-pr-detector.yml
 * 
 * Handles:
 * - Detect inactive PRs based on configurable timeframes
 * - Comprehensive activity tracking (commits, comments, reviews, timeline events)
 * - Automated stale labeling with error handling
 * - Support for scheduled and manual execution
 */

const { ConfigManager } = require('./utils/config');
const { GitHubClient } = require('./utils/github-client');

class StaleDetection {
  constructor(context, github, options = {}) {
    this.context = context;
    this.github = github;
    this.config = new ConfigManager(context, options);
    this.client = new GitHubClient(github, this.config);
    this.result = {
      labelsAdded: [],
      actions: [],
      processedPRs: 0,
      stalePRsFound: 0
    };
    
    // Default to 1 day if not specified
    this.staleDays = this.config.getStaleDays() || 1;
    this.staleThresholdMs = this.staleDays * 24 * 60 * 60 * 1000;
  }

  /**
   * Main execution function for stale detection
   */
  async execute() {
    try {
      console.log(`⏰ Starting stale detection (threshold: ${this.staleDays} day(s))`);
      
      const now = new Date();
      const pullRequests = await this.client.listOpenPRs();
      
      console.log(`Found ${pullRequests.length} open pull requests`);
      this.result.processedPRs = pullRequests.length;

      for (const pr of pullRequests) {
        try {
          await this.processPR(pr, now);
        } catch (error) {
          console.error(`Error processing PR #${pr.number}:`, error.message);
          // Continue processing other PRs even if one fails
        }
      }

      console.log(`✅ Stale detection completed: ${this.result.stalePRsFound} PRs marked as stale`);
      return this.result;

    } catch (error) {
      console.error('❌ Stale detection failed:', error.message);
      throw error;
    }
  }

  /**
   * Process a single PR for stale detection
   */
  async processPR(pr, now) {
    const prNumber = pr.number;
    
    // Skip if PR is a draft
    if (pr.draft) {
      console.log(`PR #${prNumber} is a draft, skipping`);
      return;
    }

    // Skip if PR already has stale label
    const hasStaleLabel = pr.labels.some(label => label.name === 'stale');
    if (hasStaleLabel) {
      console.log(`PR #${prNumber} already has stale label, skipping`);
      return;
    }

    // Get last activity date
    const lastActivity = await this.getLastActivityDate(prNumber);
    const timeSinceLastActivity = now - lastActivity;
    const hoursSinceActivity = Math.floor(timeSinceLastActivity / (1000 * 60 * 60));

    console.log(`PR #${prNumber}: Last activity ${hoursSinceActivity} hours ago`);

    // If no activity for more than threshold, add stale label
    if (timeSinceLastActivity > this.staleThresholdMs) {
      await this.markPRAsStale(prNumber, hoursSinceActivity);
    }
  }

  /**
   * Mark a PR as stale by adding the stale label
   */
  async markPRAsStale(prNumber, hoursSinceActivity) {
    try {
      const result = await this.client.addLabels(prNumber, ['stale']);
      
      if (result.added.length > 0) {
        this.result.labelsAdded.push(...result.added);
        this.result.actions.push(`Added stale label to PR #${prNumber} (inactive for ${hoursSinceActivity} hours)`);
        this.result.stalePRsFound++;
        console.log(`✅ Added stale label to PR #${prNumber} (inactive for ${hoursSinceActivity} hours)`);
      }
      
    } catch (error) {
      console.error(`❌ Failed to add stale label to PR #${prNumber}:`, error.message);
      throw error;
    }
  }

  /**
   * Get the last activity date for a PR by checking all activity types
   */
  async getLastActivityDate(prNumber) {
    const activities = [];

    // Get PR details for updated_at timestamp
    try {
      const prDetails = await this.client.getPR(prNumber);
      activities.push(new Date(prDetails.updated_at));
    } catch (error) {
      console.log(`Could not fetch PR details for #${prNumber}: ${error.message}`);
    }

    // Get commits
    const commits = await this.client.listPRCommits(prNumber);
    commits.forEach(commit => {
      if (commit.commit && commit.commit.committer && commit.commit.committer.date) {
        activities.push(new Date(commit.commit.committer.date));
      }
    });

    // Get issue comments
    try {
      const comments = await this.client.listComments(prNumber);
      comments.forEach(comment => {
        activities.push(new Date(comment.created_at));
      });
    } catch (error) {
      console.log(`Could not fetch comments for PR #${prNumber}: ${error.message}`);
    }

    // Get review comments
    const reviewComments = await this.client.listPRReviewComments(prNumber);
    reviewComments.forEach(comment => {
      activities.push(new Date(comment.created_at));
    });

    // Get reviews
    const reviews = await this.client.listPRReviews(prNumber);
    reviews.forEach(review => {
      if (review.submitted_at) {
        activities.push(new Date(review.submitted_at));
      }
    });

    // Get timeline events for label changes
    const timeline = await this.client.listTimelineEvents(prNumber);
    timeline.forEach(event => {
      if (event.event === 'labeled' || event.event === 'unlabeled') {
        activities.push(new Date(event.created_at));
      }
    });

    // Return the most recent activity date
    if (activities.length > 0) {
      return new Date(Math.max(...activities));
    }

    // Fallback to PR creation date if no activities found
    try {
      const prDetails = await this.client.getPR(prNumber);
      return new Date(prDetails.created_at);
    } catch (error) {
      console.log(`Could not fetch PR creation date for #${prNumber}, using current time`);
      return new Date();
    }
  }
}

module.exports = { StaleDetection };