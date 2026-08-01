#![allow(
    clippy::redundant_pub_crate,
    reason = "crate-restricted visibility keeps the migration bridge internal to the binary"
)]

use std::collections::BTreeMap;

use sqlx::PgPool;

#[derive(Debug)]
struct AppliedMigration {
    version: i64,
    checksum: Vec<u8>,
    success: bool,
}

fn verify_ledger(
    embedded: &BTreeMap<i64, Vec<u8>>,
    applied: &[AppliedMigration],
    allowed_external_max: i64,
) -> anyhow::Result<()> {
    let embedded_max = embedded.keys().next_back().copied().unwrap_or_default();
    anyhow::ensure!(
        allowed_external_max >= embedded_max,
        "migration bridge maximum cannot be below the embedded ledger"
    );
    anyhow::ensure!(
        allowed_external_max <= embedded_max + 1,
        "migration bridge may tolerate at most one externally attested additive version"
    );

    let mut previous = 0;
    for migration in applied {
        anyhow::ensure!(migration.success, "migration {} failed", migration.version);
        anyhow::ensure!(
            migration.version > previous,
            "migration ledger is not strictly ordered"
        );
        previous = migration.version;
        if let Some(expected) = embedded.get(&migration.version) {
            anyhow::ensure!(
                expected.as_slice() == migration.checksum,
                "checksum mismatch for migration {}",
                migration.version
            );
        } else {
            anyhow::ensure!(
                migration.version > embedded_max && migration.version <= allowed_external_max,
                "migration {} is absent from the embedded ledger",
                migration.version
            );
        }
    }

    let applied_max = applied
        .last()
        .map(|migration| migration.version)
        .unwrap_or_default();
    anyhow::ensure!(
        applied_max <= allowed_external_max,
        "database migration {applied_max} exceeds the authorized bridge maximum {allowed_external_max}"
    );
    Ok(())
}

/// Production application processes verify the ledger but never mutate it.
/// A separately approved workflow applies additive schema under an advisory
/// lock. Local and test processes continue to use `SQLx`'s normal migrator.
pub(crate) async fn prepare_database(pool: &PgPool, production: bool) -> anyhow::Result<()> {
    let migrator = sqlx::migrate!();
    if !production {
        migrator.run(pool).await?;
        return Ok(());
    }

    let table = sqlx::query_scalar::<_, Option<String>>(
        "SELECT to_regclass('public._sqlx_migrations')::TEXT",
    )
    .fetch_one(pool)
    .await?;
    anyhow::ensure!(
        table.is_some(),
        "production SQLx migration ledger is missing"
    );

    let rows = sqlx::query_as::<_, (i64, Vec<u8>, bool)>(
        "SELECT version, checksum, success FROM _sqlx_migrations ORDER BY version",
    )
    .fetch_all(pool)
    .await?
    .into_iter()
    .map(|(version, checksum, success)| AppliedMigration {
        version,
        checksum,
        success,
    })
    .collect::<Vec<_>>();
    let embedded = migrator
        .iter()
        .map(|migration| (migration.version, migration.checksum.to_vec()))
        .collect::<BTreeMap<_, _>>();
    let embedded_max = embedded.keys().next_back().copied().unwrap_or_default();
    let allowed_external_max = std::env::var("EPODE_MIGRATION_BRIDGE_MAX_VERSION")
        .ok()
        .map(|value| {
            value.parse::<i64>().map_err(|_| {
                anyhow::anyhow!("EPODE_MIGRATION_BRIDGE_MAX_VERSION must be an integer")
            })
        })
        .transpose()?
        .unwrap_or(embedded_max)
        .max(embedded_max);
    verify_ledger(&embedded, &rows, allowed_external_max)?;

    let applied_max = rows.last().map(|row| row.version).unwrap_or_default();
    if applied_max > embedded_max {
        tracing::warn!(
            applied_max,
            embedded_max,
            "running as an explicitly authorized additive migration bridge"
        );
    } else if applied_max < embedded_max {
        tracing::info!(
            applied_max,
            embedded_max,
            "production has a pending separately managed migration"
        );
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    #![allow(
        clippy::unwrap_used,
        reason = "small pure verifier fixtures must succeed"
    )]

    use super::*;

    fn embedded() -> BTreeMap<i64, Vec<u8>> {
        BTreeMap::from([(31, vec![31]), (32, vec![32])])
    }

    #[test]
    fn bridge_accepts_pending_or_one_authorized_future_version() {
        verify_ledger(
            &embedded(),
            &[
                AppliedMigration {
                    version: 31,
                    checksum: vec![31],
                    success: true,
                },
                AppliedMigration {
                    version: 32,
                    checksum: vec![32],
                    success: true,
                },
            ],
            33,
        )
        .unwrap();
        verify_ledger(
            &embedded(),
            &[
                AppliedMigration {
                    version: 31,
                    checksum: vec![31],
                    success: true,
                },
                AppliedMigration {
                    version: 32,
                    checksum: vec![32],
                    success: true,
                },
                AppliedMigration {
                    version: 33,
                    checksum: vec![99],
                    success: true,
                },
            ],
            33,
        )
        .unwrap();
    }

    #[test]
    fn bridge_rejects_checksum_failure_and_unapproved_versions() {
        let wrong = [AppliedMigration {
            version: 31,
            checksum: vec![0],
            success: true,
        }];
        assert!(verify_ledger(&embedded(), &wrong, 32).is_err());
        let failed = [AppliedMigration {
            version: 31,
            checksum: vec![31],
            success: false,
        }];
        assert!(verify_ledger(&embedded(), &failed, 32).is_err());
        let future = [
            AppliedMigration {
                version: 31,
                checksum: vec![31],
                success: true,
            },
            AppliedMigration {
                version: 32,
                checksum: vec![32],
                success: true,
            },
            AppliedMigration {
                version: 33,
                checksum: vec![33],
                success: true,
            },
        ];
        assert!(verify_ledger(&embedded(), &future, 32).is_err());
        assert!(verify_ledger(&embedded(), &future, 34).is_err());
    }
}
