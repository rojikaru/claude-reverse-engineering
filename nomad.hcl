variable "env_file" {
  description = "Path to .env file for Facebook Ads Library Monitor"
  type        = string
}

variable "runner_path" {
  description = "Path to bun"
  type        = string
}

variable "app_dir" {
    description = "Absolute path to app directory on Nomad client host"
    type        = string
}

job "ads-library-test-scraper" {
  datacenters = ["dc1"]
  type = "service"

  group "scraper-group" {
    task "scraper" {
            driver = "raw_exec"

            config {
                command = var.runner_path
                work_dir = var.app_dir
                args = ["run", "index.ts"]
            }

            env = {
                NODE_ENV = "production"
            }

            template {
                data        = file(var.env_file)
                destination = "local/app.env"
                env         = true  # loads file as environment variables
            }

            resources {
                cpu    = 300
                memory = 512
            }

            restart {
                attempts = 3
                interval = "30s"
                delay    = "10s"
                mode     = "fail"
            }
        }
    }
}
