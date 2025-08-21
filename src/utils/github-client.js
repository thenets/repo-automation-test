/**
 * GitHub API Client Utilities
 * Centralized GitHub API interaction layer with error handling
 * Supports all repository automation features
 */

class GitHubClient {
  constructor(github, config) {
    this.github = github;
    this.config = config;
    this.owner = config.getRepository().owner;
    this.repo = config.getRepository().repo;
  }

  /**
   * Add labels to an issue or PR
   */
  async addLabels(issueNumber, labels) {
    if (this.config.isDryRun()) {
      console.log(`🧪 DRY RUN: Would add labels [${labels.join(', ')}] to #${issueNumber}`);
      return { added: labels, skipped: false };
    }

    try {
      await this.github.rest.issues.addLabels({
        owner: this.owner,
        repo: this.repo,
        issue_number: issueNumber,
        labels: labels
      });
      
      console.log(`✅ Successfully added labels [${labels.join(', ')}] to #${issueNumber}`);
      return { added: labels, skipped: false };
      
    } catch (error) {
      return this._handleLabelError(error, issueNumber, labels, 'add');
    }
  }

  /**
   * Get labels on an issue or PR
   */
  async getLabels(issueNumber) {
    try {
      const { data: labels } = await this.github.rest.issues.listLabelsOnIssue({
        owner: this.owner,
        repo: this.repo,
        issue_number: issueNumber
      });
      
      return labels.map(label => label.name);
      
    } catch (error) {
      console.error(`❌ Error getting labels for #${issueNumber}:`, error.message);
      throw error;
    }
  }

  /**
   * Check if specific labels exist on an issue or PR
   */
  async hasLabels(issueNumber, labelNames) {
    const currentLabels = await this.getLabels(issueNumber);
    const result = {};
    
    labelNames.forEach(labelName => {
      if (labelName.endsWith('*')) {
        // Wildcard matching (e.g., "release *")
        const prefix = labelName.slice(0, -1);
        result[labelName] = currentLabels.some(label => label.startsWith(prefix));
      } else {
        // Exact matching
        result[labelName] = currentLabels.includes(labelName);
      }
    });
    
    return result;
  }

  /**
   * Get PR details
   */
  async getPR(prNumber) {
    try {
      const { data: pr } = await this.github.rest.pulls.get({
        owner: this.owner,
        repo: this.repo,
        pull_number: prNumber
      });
      
      return pr;
      
    } catch (error) {
      console.error(`❌ Error getting PR #${prNumber}:`, error.message);
      throw error;
    }
  }

  /**
   * Find PR by branch name
   */
  async findPRByBranch(branchName) {
    try {
      const { data: prs } = await this.github.rest.pulls.list({
        owner: this.owner,
        repo: this.repo,
        head: `${this.owner}:${branchName}`,
        state: 'all',
        sort: 'updated',
        direction: 'desc'
      });

      return prs.length > 0 ? prs[0] : null;
      
    } catch (error) {
      console.error(`❌ Error finding PR for branch ${branchName}:`, error.message);
      throw error;
    }
  }

  /**
   * Handle label-related errors with specific error messages
   */
  _handleLabelError(error, issueNumber, labels, action) {
    if (error.status === 403) {
      const errorMsg = `❌ Permission denied: Unable to ${action} labels [${labels.join(', ')}] to #${issueNumber}. Repository administrators should add a CUSTOM_GITHUB_TOKEN secret with appropriate permissions.`;
      console.error(errorMsg);
      throw new Error(errorMsg);
      
    } else if (error.status === 422) {
      // Check if labels already exist or if they don't exist in the repository
      return this._handle422Error(error, issueNumber, labels, action);
      
    } else {
      const errorMsg = `❌ Unexpected error ${action}ing labels [${labels.join(', ')}] to #${issueNumber}: ${error.message}`;
      console.error(errorMsg);
      throw new Error(errorMsg);
    }
  }

  /**
   * Handle 422 errors (label already exists or label doesn't exist in repo)
   */
  async _handle422Error(error, issueNumber, labels, action) {
    try {
      const currentLabels = await this.getLabels(issueNumber);
      const alreadyHasLabels = labels.filter(label => currentLabels.includes(label));
      
      if (alreadyHasLabels.length > 0) {
        console.log(`ℹ️ Labels [${alreadyHasLabels.join(', ')}] already exist on #${issueNumber} - this is expected behavior`);
        return { added: [], skipped: alreadyHasLabels };
      } else {
        const errorMsg = `❌ Failed to ${action} labels [${labels.join(', ')}] to #${issueNumber}: One or more labels don't exist in the repository.`;
        console.error(errorMsg);
        throw new Error(errorMsg);
      }
      
    } catch (listError) {
      const errorMsg = `❌ Error checking existing labels on #${issueNumber}: ${listError.message}`;
      console.error(errorMsg);
      throw new Error(errorMsg);
    }
  }

  /**
   * Create a check run
   */
  async createCheckRun(name, headSha, detailsUrl) {
    if (this.config.isDryRun()) {
      console.log(`🧪 DRY RUN: Would create check run "${name}" for ${headSha}`);
      return { data: { id: 'dry-run-check-id' } };
    }

    try {
      const checkRun = await this.github.rest.checks.create({
        owner: this.owner,
        repo: this.repo,
        name: name,
        head_sha: headSha,
        status: 'in_progress',
        started_at: new Date().toISOString(),
        details_url: detailsUrl
      });

      console.log(`📋 Created check run ${checkRun.data.id} for commit ${headSha}`);
      return checkRun;

    } catch (error) {
      console.error(`❌ Error creating check run:`, error.message);
      throw error;
    }
  }

  /**
   * Update a check run
   */
  async updateCheckRun(checkRunId, status, conclusion, output) {
    if (this.config.isDryRun()) {
      console.log(`🧪 DRY RUN: Would update check run ${checkRunId} with ${conclusion}`);
      return;
    }

    try {
      await this.github.rest.checks.update({
        owner: this.owner,
        repo: this.repo,
        check_run_id: checkRunId,
        status: status,
        conclusion: conclusion,
        completed_at: new Date().toISOString(),
        output: output
      });

      console.log(`📋 Updated check run ${checkRunId} with ${conclusion}`);

    } catch (error) {
      console.error(`❌ Error updating check run:`, error.message);
      throw error;
    }
  }

  /**
   * Create a comment on an issue or PR
   */
  async createComment(issueNumber, body) {
    if (this.config.isDryRun()) {
      console.log(`🧪 DRY RUN: Would create comment on #${issueNumber}`);
      return;
    }

    try {
      await this.github.rest.issues.createComment({
        owner: this.owner,
        repo: this.repo,
        issue_number: issueNumber,
        body: body
      });

      console.log(`💬 Posted comment to #${issueNumber}`);

    } catch (error) {
      console.error(`❌ Error creating comment:`, error.message);
      throw error;
    }
  }

  /**
   * List comments on an issue or PR
   */
  async listComments(issueNumber) {
    try {
      const { data: comments } = await this.github.rest.issues.listComments({
        owner: this.owner,
        repo: this.repo,
        issue_number: issueNumber
      });

      return comments;

    } catch (error) {
      console.error(`❌ Error listing comments for #${issueNumber}:`, error.message);
      throw error;
    }
  }

  /**
   * Delete a comment
   */
  async deleteComment(commentId) {
    if (this.config.isDryRun()) {
      console.log(`🧪 DRY RUN: Would delete comment ${commentId}`);
      return;
    }

    try {
      await this.github.rest.issues.deleteComment({
        owner: this.owner,
        repo: this.repo,
        comment_id: commentId
      });

      console.log(`🗑️ Deleted comment ${commentId}`);

    } catch (error) {
      console.error(`❌ Error deleting comment:`, error.message);
      throw error;
    }
  }

  /**
   * Clean up workflow-generated comments
   */
  async cleanupWorkflowComments(issueNumber, identifier) {
    try {
      const comments = await this.listComments(issueNumber);
      
      const workflowComments = comments.filter(comment =>
        comment.body.includes(identifier)
      );

      for (const comment of workflowComments) {
        await this.deleteComment(comment.id);
      }

      if (workflowComments.length > 0) {
        console.log(`✨ Cleaned up ${workflowComments.length} previous comment(s)`);
      }

    } catch (error) {
      console.log('ℹ️ Could not clean up previous comments (this is non-critical):', error.message);
    }
  }

  /**
   * List all open pull requests
   */
  async listOpenPRs(perPage = 100) {
    try {
      const { data: pullRequests } = await this.github.rest.pulls.list({
        owner: this.owner,
        repo: this.repo,
        state: 'open',
        per_page: perPage
      });

      return pullRequests;

    } catch (error) {
      console.error(`❌ Error listing open PRs:`, error.message);
      throw error;
    }
  }

  /**
   * Get PR commits
   */
  async listPRCommits(prNumber) {
    try {
      const { data: commits } = await this.github.rest.pulls.listCommits({
        owner: this.owner,
        repo: this.repo,
        pull_number: prNumber,
        per_page: 100
      });

      return commits;

    } catch (error) {
      console.log(`Could not fetch commits for PR #${prNumber}: ${error.message}`);
      return [];
    }
  }

  /**
   * Get PR review comments
   */
  async listPRReviewComments(prNumber) {
    try {
      const { data: comments } = await this.github.rest.pulls.listReviewComments({
        owner: this.owner,
        repo: this.repo,
        pull_number: prNumber,
        per_page: 100
      });

      return comments;

    } catch (error) {
      console.log(`Could not fetch review comments for PR #${prNumber}: ${error.message}`);
      return [];
    }
  }

  /**
   * Get PR reviews
   */
  async listPRReviews(prNumber) {
    try {
      const { data: reviews } = await this.github.rest.pulls.listReviews({
        owner: this.owner,
        repo: this.repo,
        pull_number: prNumber,
        per_page: 100
      });

      return reviews;

    } catch (error) {
      console.log(`Could not fetch reviews for PR #${prNumber}: ${error.message}`);
      return [];
    }
  }

  /**
   * Get timeline events for an issue/PR
   */
  async listTimelineEvents(issueNumber) {
    try {
      const { data: timeline } = await this.github.rest.issues.listEventsForTimeline({
        owner: this.owner,
        repo: this.repo,
        issue_number: issueNumber,
        per_page: 100
      });

      return timeline;

    } catch (error) {
      console.log(`Could not fetch timeline for #${issueNumber}: ${error.message}`);
      return [];
    }
  }
}

module.exports = { GitHubClient };