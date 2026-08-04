#![allow(
    clippy::redundant_pub_crate,
    reason = "crate-restricted visibility keeps the migration bridge internal to the binary"
)]

use std::collections::BTreeMap;

use sqlx::{PgPool, migrate::Migrator};

// Migration 39's SQL was unchanged, but its rollout-only marker was added after
// some local databases had applied it and before production applied it.
const MIGRATION_39_VERSION: i64 = 39;
const MIGRATION_39_CANONICAL_CHECKSUM: [u8; 48] = [
    0xc9, 0x47, 0xcc, 0x2a, 0x27, 0x3d, 0xca, 0xa0, 0x93, 0x9f, 0x3e, 0x9d, 0x3f, 0x11, 0xde, 0x1e,
    0x7e, 0x5a, 0x16, 0x7e, 0x8f, 0xb8, 0xc8, 0x80, 0x5b, 0x33, 0x51, 0x66, 0x51, 0xc4, 0xb3, 0x2b,
    0xb7, 0xf6, 0x9b, 0xf1, 0xfa, 0x11, 0x57, 0x29, 0x01, 0x58, 0x84, 0xd8, 0x66, 0xe7, 0x6d, 0x6f,
];
const MIGRATION_39_PRE_MARKER_CHECKSUM: [u8; 48] = [
    0x5a, 0x13, 0xd0, 0xea, 0xbf, 0xe4, 0x6e, 0x26, 0xee, 0x10, 0xaf, 0x90, 0x39, 0x1d, 0xce, 0x89,
    0xeb, 0x5c, 0xe1, 0x41, 0xa5, 0x07, 0x5f, 0x0c, 0x7c, 0x43, 0x33, 0xce, 0xa3, 0x44, 0x6b, 0x26,
    0x53, 0x38, 0x2a, 0xee, 0x4d, 0xe5, 0x04, 0xcb, 0x25, 0xaf, 0x02, 0x98, 0xee, 0x06, 0x9a, 0x48,
];

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

fn local_migration_checksum_is_compatible(
    version: i64,
    embedded_checksum: &[u8],
    applied_checksum: &[u8],
) -> bool {
    embedded_checksum == applied_checksum
        || (version == MIGRATION_39_VERSION
            && embedded_checksum == MIGRATION_39_CANONICAL_CHECKSUM
            && applied_checksum == MIGRATION_39_PRE_MARKER_CHECKSUM)
}

async fn normalize_pre_marker_migration_39_checksum(
    pool: &PgPool,
    migrator: &Migrator,
) -> anyhow::Result<()> {
    let embedded_checksum = migrator
        .iter()
        .find(|migration| migration.version == MIGRATION_39_VERSION)
        .map(|migration| migration.checksum.as_ref())
        .ok_or_else(|| anyhow::anyhow!("embedded migration 39 is missing"))?;
    anyhow::ensure!(
        embedded_checksum == MIGRATION_39_CANONICAL_CHECKSUM,
        "embedded migration 39 does not match the production-applied checksum"
    );

    let table = sqlx::query_scalar::<_, Option<String>>(
        "SELECT to_regclass('public._sqlx_migrations')::TEXT",
    )
    .fetch_one(pool)
    .await?;
    if table.is_none() {
        return Ok(());
    }

    let applied_checksum = sqlx::query_scalar::<_, Vec<u8>>(
        "SELECT checksum FROM _sqlx_migrations WHERE version = $1 AND success = TRUE",
    )
    .bind(MIGRATION_39_VERSION)
    .fetch_optional(pool)
    .await?;
    let Some(applied_checksum) = applied_checksum else {
        return Ok(());
    };
    if applied_checksum == embedded_checksum
        || !local_migration_checksum_is_compatible(
            MIGRATION_39_VERSION,
            embedded_checksum,
            &applied_checksum,
        )
    {
        return Ok(());
    }

    let updated = sqlx::query(
        "UPDATE _sqlx_migrations SET checksum = $1
        WHERE version = $2 AND success = TRUE AND checksum = $3",
    )
    .bind(MIGRATION_39_CANONICAL_CHECKSUM.as_slice())
    .bind(MIGRATION_39_VERSION)
    .bind(MIGRATION_39_PRE_MARKER_CHECKSUM.as_slice())
    .execute(pool)
    .await?;
    anyhow::ensure!(
        updated.rows_affected() <= 1,
        "migration 39 checksum normalization changed multiple ledger rows"
    );
    if updated.rows_affected() == 1 {
        tracing::warn!(
            version = MIGRATION_39_VERSION,
            "normalized the attested pre-marker local migration checksum"
        );
    }
    Ok(())
}

/// Production application processes verify the ledger but never mutate it.
/// A separately approved workflow applies additive schema under an advisory
/// lock. Local and test processes continue to use `SQLx`'s normal migrator.
pub(crate) async fn prepare_database(pool: &PgPool, production: bool) -> anyhow::Result<()> {
    let migrator = sqlx::migrate!();
    if !production {
        normalize_pre_marker_migration_39_checksum(pool, &migrator).await?;
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

    #[test]
    fn local_bridge_accepts_only_the_attested_migration_39_checksums() {
        assert!(local_migration_checksum_is_compatible(
            39,
            &MIGRATION_39_CANONICAL_CHECKSUM,
            &MIGRATION_39_CANONICAL_CHECKSUM,
        ));
        assert!(local_migration_checksum_is_compatible(
            39,
            &MIGRATION_39_CANONICAL_CHECKSUM,
            &MIGRATION_39_PRE_MARKER_CHECKSUM,
        ));

        let mut unknown_checksum = MIGRATION_39_PRE_MARKER_CHECKSUM;
        unknown_checksum[0] ^= 1;
        assert!(!local_migration_checksum_is_compatible(
            39,
            &MIGRATION_39_CANONICAL_CHECKSUM,
            &unknown_checksum,
        ));
        assert!(!local_migration_checksum_is_compatible(
            38,
            &MIGRATION_39_CANONICAL_CHECKSUM,
            &MIGRATION_39_PRE_MARKER_CHECKSUM,
        ));
        assert!(!local_migration_checksum_is_compatible(
            39,
            &unknown_checksum,
            &MIGRATION_39_PRE_MARKER_CHECKSUM,
        ));
    }
}
