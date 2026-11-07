"""Creates and configures the three Hetzner Object Storage buckets:

  <HETZNER_BUCKET>-originals  private   uploaded originals (browser uploads straight into it)
  <HETZNER_BUCKET>-stream     public    HLS, MP4 qualities, DASH (Cloudflare in front)
  <HETZNER_BUCKET>-thumbs     public    thumbnails and seek-bar sprites (Cloudflare in front)

CORS lets the browser PUT parts directly (and read ETag), lifecycle drops unfinished multipart uploads after a day.
Originals leave Object Storage for the Storage Box after 7 days through the archive job (Hetzner Object Storage has
one storage class, so this is done by the platform rather than by a lifecycle transition).

    python -m scripts.setup_hetzner            # uses .env
"""

import json
import sys

from botocore.exceptions import ClientError

from app.config import get_settings
from app.services import hetzner_storage as hz


def public_read_policy(bucket: str) -> str:
    return json.dumps({"Version": "2012-10-17", "Statement": [
        {"Sid": "PublicRead", "Effect": "Allow", "Principal": "*", "Action": ["s3:GetObject"], "Resource": [f"arn:aws:s3:::{bucket}/*"]}]})


def main() -> None:
    s = get_settings()
    if s.storage_backend != "hetzner":
        sys.exit("STORAGE_BACKEND must be hetzner")
    c = hz.get_client()
    origins = sorted({s.frontend_url.rstrip("/"), *[o.strip() for o in s.cors_origins.split(",") if o.strip()]})
    for kind in ("originals", "stream", "thumbs"):
        name = hz.bucket(kind)
        try:
            try:
                c.create_bucket(Bucket=name, CreateBucketConfiguration={"LocationConstraint": s.hetzner_region})
            except ClientError as e:
                if e.response["Error"]["Code"] not in ("InvalidLocationConstraint", "IllegalLocationConstraintException"):
                    raise
                c.create_bucket(Bucket=name)
            print(f"created {name}")
        except ClientError as e:
            if e.response["Error"]["Code"] not in ("BucketAlreadyOwnedByYou", "BucketAlreadyExists"):
                raise
            print(f"exists  {name}")
        c.put_bucket_cors(Bucket=name, CORSConfiguration={"CORSRules": [{
            "AllowedOrigins": origins if kind == "originals" else ["*"],
            "AllowedMethods": ["PUT", "GET", "HEAD"] if kind == "originals" else ["GET", "HEAD"],
            "AllowedHeaders": ["*"], "ExposeHeaders": ["ETag", "Content-Length"], "MaxAgeSeconds": 3600}]})
        rules = [{"ID": "abort-unfinished-multipart", "Status": "Enabled", "Filter": {"Prefix": ""},
                  "AbortIncompleteMultipartUpload": {"DaysAfterInitiation": 1}}]
        if kind == "originals":
            rules.append({"ID": "expire-speedtests", "Status": "Enabled", "Filter": {"Prefix": "speedtest/"}, "Expiration": {"Days": 1}})
        c.put_bucket_lifecycle_configuration(Bucket=name, LifecycleConfiguration={"Rules": rules})
        if kind != "originals":
            try:
                c.put_bucket_policy(Bucket=name, Policy=public_read_policy(name))
            except ClientError as e:  # some S3 servers only support object ACLs; files are also uploaded public-read
                print(f"  bucket policy not set ({e.response['Error']['Code']}); relying on object ACLs")
        print(f"  CORS for {', '.join(origins) if kind == 'originals' else 'all sites'}; unfinished multipart uploads removed after 1 day")
    print("Done. Point Cloudflare at the -stream and -thumbs buckets (see README).")


if __name__ == "__main__":
    main()
