use std::path::PathBuf;

use anyhow::Context;
use bt_server::Config;
use clap::{Parser, Subcommand};
use tracing_subscriber::EnvFilter;

#[derive(Parser)]
#[command(
    name = "bakatavern",
    version,
    about = "BakaTavern: a light, fast and elegant SillyTavern"
)]
struct Cli {
    /// Data directory (database, files, configuration).
    #[arg(long, env = "BT_DATA_DIR", default_value = "data", global = true)]
    data_dir: PathBuf,

    #[command(subcommand)]
    command: Option<Command>,
}

#[derive(Subcommand)]
enum Command {
    /// Run the server (the default command).
    Serve {
        /// Address to listen on (overrides config.toml).
        #[arg(long)]
        host: Option<String>,
        /// Port to listen on (overrides config.toml).
        #[arg(long)]
        port: Option<u16>,
        /// Set the login password before starting.
        #[arg(long, env = "BT_PASSWORD", hide_env_values = true)]
        password: Option<String>,
    },
    /// Import a SillyTavern data folder or backup zip: cards, chats, lorebooks, presets,
    /// personas and tags; settings are applied the next time the web app opens.
    ImportSt {
        /// SillyTavern folder (its install folder, `data/<user>`) or a backup zip.
        path: PathBuf,
        /// BakaTavern user to import into (the default user when omitted).
        #[arg(long)]
        user: Option<String>,
        /// Also import the API keys from secrets.json.
        #[arg(long)]
        secrets: bool,
    },
    /// Set or clear a user's login password.
    Passwd {
        /// User handle (the default user when omitted).
        #[arg(long)]
        user: Option<String>,
        /// Remove the password instead of setting one.
        #[arg(long)]
        clear: bool,
    },
}

fn read_password() -> anyhow::Result<String> {
    eprint!("New password: ");
    let mut line = String::new();
    std::io::stdin().read_line(&mut line)?;
    let password = line.trim_end_matches(['\r', '\n']).to_string();
    anyhow::ensure!(
        password.chars().count() >= 4,
        "the password must have at least 4 characters"
    );
    Ok(password)
}

fn print_import_report(report: &bt_server::st_import::StImportReport) {
    eprintln!(
        "Imported {} characters, {} chats, {} lorebooks, {} presets, {} personas, {} keys.",
        report.characters,
        report.chats,
        report.lorebooks,
        report.presets,
        report.personas,
        report.secrets
    );
    if report.unchanged > 0 {
        eprintln!(
            "{} items were already here and were left as they are.",
            report.unchanged
        );
    }
    if report.settings {
        eprintln!("Settings will be applied the next time BakaTavern opens in the browser.");
    }
    if !report.skipped.is_empty() {
        let skipped: Vec<String> = report
            .skipped
            .iter()
            .map(|(k, n)| format!("{k}: {n}"))
            .collect();
        eprintln!("Not imported yet (later versions): {}", skipped.join(", "));
    }
    for failure in &report.failures {
        eprintln!("  failed: {}: {}", failure.file, failure.message);
    }
}

/// Ctrl-C, or SIGTERM (`docker stop`, systemd).
async fn shutdown_signal() {
    #[cfg(unix)]
    {
        use tokio::signal::unix::{SignalKind, signal};
        match signal(SignalKind::terminate()) {
            Ok(mut term) => {
                tokio::select! {
                    _ = tokio::signal::ctrl_c() => {}
                    _ = term.recv() => {}
                }
            }
            Err(_) => {
                let _ = tokio::signal::ctrl_c().await;
            }
        }
    }
    #[cfg(not(unix))]
    {
        let _ = tokio::signal::ctrl_c().await;
    }
}

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    tracing_subscriber::fmt()
        .with_env_filter(
            EnvFilter::try_from_env("BT_LOG")
                .unwrap_or_else(|_| EnvFilter::new("info,tower_http=warn")),
        )
        .init();
    let cli = Cli::parse();
    let mut config = Config::load(&cli.data_dir).context("loading the configuration")?;
    match cli.command.unwrap_or_else(|| Command::Serve {
        host: None,
        port: None,
        password: std::env::var("BT_PASSWORD").ok(),
    }) {
        Command::Serve {
            host,
            port,
            password,
        } => {
            if let Some(host) = host {
                config.server.host = host;
            }
            if let Some(port) = port {
                config.server.port = port;
            }
            if let Some(password) = password.filter(|p| !p.is_empty()) {
                bt_server::set_password(&config, None, Some(&password))?;
            }
            bt_server::serve(config, async {
                shutdown_signal().await;
                tracing::info!("shutting down");
            })
            .await
        }
        Command::ImportSt {
            path,
            user,
            secrets,
        } => {
            let report = bt_server::import_st(
                config,
                &path,
                user,
                bt_server::st_import::ImportOptions { secrets },
            )
            .await?;
            print_import_report(&report);
            Ok(())
        }
        Command::Passwd { user, clear } => {
            let password = if clear { None } else { Some(read_password()?) };
            bt_server::set_password(&config, user.as_deref(), password.as_deref())?;
            eprintln!(
                "{}",
                if clear {
                    "Password removed."
                } else {
                    "Password updated."
                }
            );
            Ok(())
        }
    }
}
