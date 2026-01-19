# SSM Parameter Store Env Loader

A GitHub Action that fetches parameters from AWS SSM Parameter Store and either exports them as environment variables or saves them to a file (e.g., `.env`).

## Features

- **Recursive Search**: Automatically fetches all parameters under the specified `aws-base-path` recursively.
- **Auto Decryption**: Automatically decrypts `SecureString` parameters.
- **Security First**: All fetched values are automatically masked as secrets in GitHub Actions logs.
- **Key Transformation**: Parameter paths are trimmed to their base names (e.g., `/prod/service/DB_HOST` becomes `DB_HOST`).
- **Flexible Output**: Load directly into the GitHub Actions environment or export to an environment file.

## Usage

In your `.github/workflows` YAML file:

```yaml
steps:
  - name: Configure AWS Credentials
    uses: aws-actions/configure-aws-credentials@v4
    with:
      aws-access-key-id: ${{ secrets.AWS_ACCESS_KEY_ID }}
      aws-secret-access-key: ${{ secrets.AWS_SECRET_ACCESS_KEY }}
      aws-region: ap-northeast-2

  - name: Load Secrets from SSM
    uses: luviny/aws-ssm-parameter-store-env-loader@v1 # Replace with actual version
    with:
      aws-base-path: /my-service/prod/
      # Optional: default is ap-northeast-2
      aws-region: ap-northeast-2
      # Optional: whether to export to env variables (default true)
      load-env: true
      # Optional: specify a filename to create an env file
      env-file-name: .env

  - name: Check Env
    run: |
      echo "DB_HOST is set to $DB_HOST" # Value will be masked as ***
```

## Inputs

| Input | Required | Default | Description |
| :--- | :---: | :---: | :--- |
| `aws-base-path` | **Yes** | - | The base path in SSM Parameter Store to search recursively. |
| `aws-region` | No | `ap-northeast-2` | The AWS region. |
| `load-env` | No | `true` | Whether to export the parameters as environment variables. |
| `env-file-name` | No | - | The output filename to store parameters (e.g. `.env`). |

## Example

If your SSM Parameter Store has:
- `/my-service/prod/DATABASE_URL`: `postgres://...`
- `/my-service/prod/API_KEY`: `secret-key`

Running with `aws-base-path: /my-service/prod/`:

1. **Environment Variables (`load-env: true`)**:
   - `DATABASE_URL` and `API_KEY` will be available in subsequent steps via `$DATABASE_URL` or `${{ env.DATABASE_URL }}`.

2. **Environment File (`env-file-name: .env`)**:
   - A `.env` file will be created:
     ```env
     DATABASE_URL="postgres://..."
     API_KEY="secret-key"
     ```

## Development

This project is built with TypeScript.

### Install Dependencies
```bash
pnpm install
```

### Build
Build the project into a single file using `ncc` for GitHub Actions:
```bash
pnpm build
```

### Development
```bash
pnpm dev
```