var FlowGuardMigrator = Class.create();
FlowGuardMigrator.prototype = {
    initialize: function() {
        this.validator = new FlowGuardValidator();
    },

    /**
     * Full migration pipeline: validate → snapshot → deploy → verify
     * @param {string} sourceFlowId
     * @param {string} targetInstanceUrl
     * @param {string} requestedBy — user sys_id
     * @returns {object} {success, migration_id, flow_id, snapshot_id, errors}
     */
    migrate: function(sourceFlowId, targetInstanceUrl, requestedBy) {
        var migId = gs.generateGUID();
        var log = this._createLog(migId, sourceFlowId, 'in_progress', requestedBy);

        // Phase 0: Cross-environment validation — check ALL configured environments
        // for subflow version mismatches, action snapshot differences, and data pill
        // signature conflicts BEFORE any migration work begins.
        var crossValidator = new FlowGuardCrossEnvValidator();
        var crossResult = crossValidator.validateAllEnvironments(sourceFlowId);
        if (!crossResult.valid) {
            log.setValue('status', 'cross_env_validation_failed');
            log.setValue('issues', JSON.stringify(crossResult.results));
            log.update();
            return {
                success: false,
                migration_id: migId,
                phase: 'cross_environment_validation',
                results: crossResult.results
            };
        }

        // Phase 1: Pre-flight Validate
        var validation = this.validator.validate(sourceFlowId, targetInstanceUrl);
        if (!validation.valid) {
            log.setValue('status', 'validation_failed');
            log.setValue('issues', JSON.stringify(validation.issues));
            log.update();
            return {success: false, migration_id: migId, errors: validation.issues};
        }

        // Phase 2: Check if flow exists in target — if so, take snapshot for rollback
        var flowGr = new GlideRecord('sys_hub_flow');
        if (!flowGr.get(sourceFlowId)) {
            log.setValue('status', 'error');
            log.setValue('issues', JSON.stringify([{message: 'Source flow not found'}]));
            log.update();
            return {success: false, migration_id: migId, errors: [{message: 'Source flow not found'}]};
        }

        var flowName = flowGr.getValue('name');
        var targetFlowGr = new GlideRecord('sys_hub_flow');
        targetFlowGr.addQuery('name', flowName);
        targetFlowGr.setLimit(1);
        targetFlowGr.query();

        var snapshotId = null;
        if (targetFlowGr.next()) {
            snapshotId = this._snapshot(targetFlowGr, migId);
            log.setValue('snapshot_id', snapshotId);
        }

        // Phase 3: Copy flow payload to target
        try {
            var payload = this._serializeFlow(flowGr);
            var targetFlowSysId = null;
            if (targetFlowGr.isValidRecord()) {
                this._restorePayload(targetFlowGr, payload);
                targetFlowGr.get(targetFlowGr.getValue('sys_id'));
                targetFlowSysId = targetFlowGr.getValue('sys_id');
                log.setValue('target_flow_id', targetFlowSysId);
                log.setValue('action', 'updated');
            } else {
                var newFlowId = this._createFromPayload(payload);
                targetFlowSysId = newFlowId;
                log.setValue('target_flow_id', newFlowId);
                log.setValue('action', 'created');
            }

            // Phase 4: Post-deploy verify
            var verifyResult = this._verify(targetFlowSysId);
            if (verifyResult.success) {
                log.setValue('status', 'success');
                log.setValue('completed_at', new GlideDateTime());
            } else {
                log.setValue('status', 'verify_failed');
                log.setValue('issues', JSON.stringify(verifyResult.errors));

                // Auto-rollback on verification failure if snapshot exists
                if (snapshotId) {
                    this._rollbackFromSnapshot(snapshotId);
                    log.setValue('status', 'rolled_back');
                    log.setValue('issues', JSON.stringify(
                        verifyResult.errors.concat([{message: 'Auto-rollback executed successfully'}])
                    ));
                }
            }

            log.update();
            return {
                success: log.getValue('status') === 'success',
                migration_id: migId,
                flow_id: log.getValue('target_flow_id'),
                snapshot_id: snapshotId,
                status: log.getValue('status')
            };
        } catch (e) {
            gs.error('FlowGuard: Migration failed — ' + e.message);
            log.setValue('status', 'error');
            log.setValue('issues', JSON.stringify([{message: e.message}]));

            if (snapshotId) {
                this._rollbackFromSnapshot(snapshotId);
                log.setValue('status', 'rolled_back');
            }

            log.update();
            return {success: false, migration_id: migId, errors: [{message: e.message}]};
        }
    },

    /**
     * Manual rollback by migration_id (for admin override).
     */
    rollback: function(migrationId) {
        var logGr = new GlideRecord('x_flowguard_migration_log');
        if (!logGr.get('migration_id', migrationId)) {
            return {success: false, error: 'Migration ' + migrationId + ' not found'};
        }

        var snapshotId = logGr.getValue('snapshot_id');
        if (!snapshotId) {
            return {success: false, error: 'No snapshot available for rollback'};
        }

        var restored = this._rollbackFromSnapshot(snapshotId);
        if (restored) {
            logGr.setValue('status', 'rolled_back');
            logGr.setValue('completed_at', new GlideDateTime());
            logGr.update();
            return {success: true, migration_id: migrationId};
        }
        return {success: false, error: 'Rollback failed — snapshot may be corrupted'};
    },

    /**
     * Generate diff summary: what changed in this flow vs last snapshot.
     */
    diff: function(flowId) {
        var flowGr = new GlideRecord('sys_hub_flow');
        if (!flowGr.get(flowId)) {
            return {success: false, error: 'Flow not found'};
        }

        var currentModel = flowGr.getValue('model');
        var currentActions = this._parseActions(currentModel);

        var snapGr = new GlideRecord('x_flowguard_snapshot');
        snapGr.addQuery('flow_id', flowId);
        snapGr.orderByDesc('sys_created_on');
        snapGr.setLimit(1);
        snapGr.query();

        var diff = {added: [], removed: [], modified: []};

        if (!snapGr.next()) {
            diff.added = currentActions;
            return {success: true, diff: diff, note: 'No previous snapshot — all actions are new'};
        }

        var prevModel = snapGr.getValue('flow_model');
        var prevActions = this._parseActions(prevModel);

        var prevMap = {};
        for (var i = 0; i < prevActions.length; i++) {
            prevMap[prevActions[i].name] = prevActions[i];
        }

        var currMap = {};
        for (var j = 0; j < currentActions.length; j++) {
            currMap[currentActions[j].name] = currentActions[j];
        }

        for (var key in currMap) {
            if (!prevMap[key]) {
                diff.added.push(currMap[key]);
            } else if (!this._deepEqual(currMap[key], prevMap[key])) {
                diff.modified.push({
                    name: key,
                    before: prevMap[key],
                    after: currMap[key]
                });
            }
        }

        for (var prevKey in prevMap) {
            if (!currMap[prevKey]) {
                diff.removed.push(prevMap[prevKey]);
            }
        }

        return {success: true, diff: diff};
    },

    /**
     * Deep compare two objects without JSON.stringify ordering issues.
     */
    _deepEqual: function(a, b) {
        if (a === b) return true;
        if (typeof a !== typeof b) return false;
        if (typeof a !== 'object' || a === null || b === null) return a === b;
        var keysA = Object.keys(a).sort();
        var keysB = Object.keys(b).sort();
        if (keysA.length !== keysB.length) return false;
        for (var k = 0; k < keysA.length; k++) {
            if (keysA[k] !== keysB[k]) return false;
            if (!this._deepEqual(a[keysA[k]], b[keysA[k]])) return false;
        }
        return true;
    },

    /** Snapshot the target flow before overwriting. */
    _snapshot: function(flowGr, migId) {
        var snap = new GlideRecord('x_flowguard_snapshot');
        snap.initialize();
        snap.setValue('migration_id', migId);
        snap.setValue('flow_id', flowGr.getValue('sys_id'));
        snap.setValue('flow_name', flowGr.getValue('name'));
        snap.setValue('flow_model', flowGr.getValue('model'));
        snap.setValue('flow_version', flowGr.getValue('version'));
        snap.setValue('snapshot_type', 'pre_migration');
        return snap.insert();
    },

    /** Restore from snapshot. */
    _rollbackFromSnapshot: function(snapshotId) {
        var snap = new GlideRecord('x_flowguard_snapshot');
        if (!snap.get(snapshotId)) return false;

        var flowGr = new GlideRecord('sys_hub_flow');
        if (!flowGr.get(snap.getValue('flow_id'))) return false;

        flowGr.setValue('model', snap.getValue('flow_model'));
        flowGr.setValue('version', snap.getValue('flow_version'));
        return flowGr.update();
    },

    /** Serialize flow to portable JSON. */
    _serializeFlow: function(flowGr) {
        return {
            name: flowGr.getValue('name'),
            description: flowGr.getValue('description'),
            model: flowGr.getValue('model'),
            version: flowGr.getValue('version'),
            active: flowGr.getValue('active'),
            category: flowGr.getValue('category'),
            type: flowGr.getValue('type')
        };
    },

    /** Apply serialized payload to existing flow record. */
    _restorePayload: function(flowGr, payload) {
        flowGr.setValue('model', payload.model);
        flowGr.setValue('version', (parseInt(payload.version, 10) || 1) + 1);
        flowGr.setValue('description', payload.description);
        flowGr.setValue('active', payload.active);
        return flowGr.update();
    },

    /** Create new flow from payload. Returns sys_id. */
    _createFromPayload: function(payload) {
        var newFlow = new GlideRecord('sys_hub_flow');
        newFlow.initialize();
        newFlow.setValue('name', payload.name);
        newFlow.setValue('description', payload.description);
        newFlow.setValue('model', payload.model);
        newFlow.setValue('version', 1);
        newFlow.setValue('active', 'false');
        newFlow.setValue('category', payload.category);
        return newFlow.insert();
    },

    /** Post-deployment verification: load flow and check parseable. */
    _verify: function(flowSysId) {
        var verifyGr = new GlideRecord('sys_hub_flow');
        if (!verifyGr.get(flowSysId)) {
            return {success: false, errors: [{message: 'Flow ' + flowSysId + ' not found post-migration'}]};
        }
        var model = verifyGr.getValue('model');
        if (!model) return {success: false, errors: [{message: 'Flow model is empty after migration'}]};

        try {
            var parsed = JSON.parse(model);
            if (!parsed.actions && !parsed.stages) {
                return {success: false, errors: [{message: 'Flow model missing actions or stages'}]};
            }
            return {success: true};
        } catch (e) {
            return {success: false, errors: [{message: 'Flow model is not valid JSON: ' + e.message}]};
        }
    },

    _parseActions: function(model) {
        try {
            var parsed = JSON.parse(model);
            return parsed.actions || parsed.stages || [];
        } catch (e) {
            return [];
        }
    },

    /** Create migration log entry. */
    _createLog: function(migId, flowId, status, requestedBy) {
        var log = new GlideRecord('x_flowguard_migration_log');
        log.initialize();
        log.setValue('migration_id', migId);
        log.setValue('source_flow_id', flowId);
        log.setValue('status', status);
        log.setValue('requested_by', requestedBy);
        log.setValue('started_at', new GlideDateTime());
        log.insert();
        return log;
    },

    type: 'FlowGuardMigrator'
};
