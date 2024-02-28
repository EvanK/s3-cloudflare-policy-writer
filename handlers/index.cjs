/* NOTE:
For now, putting code inline into the CF template (with ZipFile) requires us
to use CommonJS instead of ES Modules.
See: https://github.com/aws-cloudformation/cloudformation-coverage-roadmap/issues/1832
*/
const assert = require('node:assert/strict');

const {
  S3Client,
  GetBucketLocationCommand,
  GetBucketPolicyCommand,
  PutBucketPolicyCommand,
} = require('@aws-sdk/client-s3');

// needed if no existing bucket policy, to house our statement
const docSkeleton = '{"Version":"2012-10-17","Statement":[]}';

// define our base statement ID and structure
const Sid = 'S3CloudflarePolicyWriterManagedStatement';
const baseStatement = {
  Sid,
  // allows get of any object from this bucket
  Effect: 'Allow',
  Action: 's3:GetObject',
  Principal: '*',
  Resource: 'arn:aws:s3:::__BUCKET_NAME__/*',
  // ^^ need to specify full ARN of each bucket to which this policy is attached
  // only when the source ip is in the given range(s)
  Condition: {
    IpAddress: {
      'aws:SourceIp': [],
    },
  },
};

exports.handler = async (event, context) => {
  const {
    LOG_VERBOSE = false,
    // ^ extra logging for debug purposes
    AWS_REGION,
    TARGET_BUCKETS,
    /** ^^
     * can't default this, so we'll need AT LEAST one bucket name to which we'll
     * be writing directly attached bucket policies. could accept more than one
     * bucket name, assuming comma-delimited.
     * - 'static.example.com'
     * - 'cdn.example.com,content.example.com,assets.example.com'
     */
  } = process.env;

  // support verbose logging based on a provided env variable
  const verbose = (...messages) => {
    if (LOG_VERBOSE) console.log(...messages);
  };

  // fetch ipv4 and v6 ranges, merge them to single array, and assign to policy doc
  const ipsV4 = await (await fetch('https://www.cloudflare.com/ips-v4')).text();
  const ipsV6 = await (await fetch('https://www.cloudflare.com/ips-v6')).text();
  const cfRanges = `${ipsV4}\n${ipsV6}`
    .split("\n")
    .filter(x => x)
  ;
  verbose(`Got ${cfRanges.length} IP ranges from Cloudflare:`, cfRanges);
  baseStatement.Condition.IpAddress['aws:SourceIp'] = cfRanges;

  // parse out current AWS account number
  const awsAccountId = context.invokedFunctionArn.split(':')[4];
  verbose(`Got current operating account id: ${awsAccountId}`);

  // split buckets and convert to per-bucket objects
  if (!TARGET_BUCKETS) {
    throw new Error(`Missing target bucket list: ${TARGET_BUCKETS}`);
  }
  const targetBuckets = TARGET_BUCKETS
    .split(',')
    .map( bucketName => ({bucketName}) )
  ;
  verbose(`Got ${targetBuckets.length} target buckets:`, targetBuckets);

  // create a client, initially in our current region
  const client = {
    [AWS_REGION]: new S3Client({
      region: AWS_REGION
    })
  };

  // iterate buckets initially to:
  // (1) confirm access
  // (2) get current bucket policies
  // (3) check whether update necessary
  for (let currentBucket in targetBuckets) {
    const targetBucket = targetBuckets[currentBucket];

    // get region in which current bucket lives
    // storing getException for later, if it fails
    try {
      const getBucketLocationCommand = new GetBucketLocationCommand({
        Bucket: targetBucket.bucketName,
        ExpectedBucketOwner: awsAccountId,
      });
      const {
        LocationConstraint: bucketRegion = 'us-east-1',
        // ^^ Buckets in Region us-east-1 will have a LocationConstraint of null.
      } = await client[AWS_REGION].send(getBucketLocationCommand);

      // record bucket region for later use
      targetBucket.region = bucketRegion;

      // create new client in bucket region, if it differs from current region
      if (bucketRegion != AWS_REGION) {
        verbose(`Found bucket ${targetBucket.bucketName} in different region (vs current of ${AWS_REGION}): ${bucketRegion}`);
        client[bucketRegion] = new S3Client({ region: bucketRegion });
      }
    } catch (err) {
      targetBucket.getException = err;
      // skip all policy stuff below, as we likely won't have access
      continue;
    }

    // attempt to get existing policy for given bucket
    // storing getException for later, if it fails
    try {
      const getBucketPolicyCommand = new GetBucketPolicyCommand({
        Bucket: targetBucket.bucketName,
        ExpectedBucketOwner: awsAccountId,
      });
      const { Policy: targetPolicy } = await client[targetBucket.region].send(getBucketPolicyCommand);
      targetBucket.currentPolicy = targetPolicy;
      verbose(`Got ${targetPolicy.length} bytes of policy for bucket ${targetBucket.bucketName}`);
    } catch (err) {
      if (err.message !== 'The bucket policy does not exist') {
        targetBucket.getException = err;
        // skip parse + compare below
        continue;
      }
    }

    // handle empty policies that may come back as unparseable values
    // like undefined or empty string
    if (!targetBucket.currentPolicy) {
      targetBucket.differs = true;
      verbose(`Empty/missing policy for bucket ${targetBucket.bucketName}`);
      continue;
    }

    // catch any JSON syntax errors as necessary
    let testPolicy;
    try {
      // otherwise parse a populated JSON string
      testPolicy = JSON.parse(targetBucket.currentPolicy);
      // reassign parsed policy as object over JSON policy string
      targetBucket.currentPolicy = testPolicy;
    } catch (err) {
      targetBucket.parseException = err;
      // skip compare below
      continue;
    }

    // ensure first that policy HAS a Statements array
    if (
      (!testPolicy.hasOwnProperty('Statement')) 
      ||
      (!Array.isArray(testPolicy.Statement))
    ) {
      targetBucket.differs = true;
      verbose(`Policy missing statements list for bucket ${targetBucket.bucketName}:`, testPolicy?.Statement);
      continue;
    }

    // get our target statement, by Sid
    const testStatements = testPolicy.Statement.filter(s => s.Sid === Sid);
    switch (testStatements.length) {
      // compare statement, if found
      case 1:
        try {
          // clone base statement, subbing in the current bucket name
          const expected = JSON.parse(JSON.stringify(baseStatement));
          expected.Resource = expected.Resource.replace('__BUCKET_NAME__', targetBucket.bucketName);
          // THEN compare against expected
          assert.deepStrictEqual(testStatements[0], expected);
          targetBucket.differs = false;
        } catch (err) {
          targetBucket.differs = true;
        }
        break;
      // mark as differed, if not found
      case 0:
        targetBucket.differs = true;
        break;
      // same with extra logging, if multiple found
      default:
        targetBucket.differs = true;
        verbose(`Policy has ${testStatements.length} duplicate statements with Sid "${Sid}"`);
    }

    verbose(`Policy ${targetBucket.differs ? 'differs' : 'up to date'} for bucket ${targetBucket.bucketName}`);
  }

  // simple test of whether ANY get/parse exceptions exist
  let hasExceptions = targetBuckets.reduce(
    (res, curr) => {
      if (res) return res;
      return !!(curr.getException || curr.parseException);
    },
    false
  );

  // bail early with a report of WHICH buckets failed and why
  if (hasExceptions) {
    console.log('Following buckets failed to get or parse current bucket policies:');
    console.table(
      targetBuckets
      .filter(b => b.getException || b.parseException)
      .map(b => ({
          'bucket': b.bucketName,
          'get': b.getException?.toString(),
          'parse': b.parseException?.toString(),
        })
      )
    );
    return;
  }

  // bail early if all bucket policies are up to date
  if (targetBuckets.filter(b => b.differs).length < 1) {
    console.log('All bucket policies are up to date!');
    return true;
  }

  // iterate buckets once more to update any differing policies
  let updateSuccesses = 0;
  for (let currentBucket in targetBuckets) {
    const targetBucket = targetBuckets[currentBucket];
    let targetPolicy = targetBucket.currentPolicy;

    // skip any bucket already matching base document policy
    if (!targetBucket.differs) continue;

    // define a base document, if needed (cloning doc skeleton)
    if (!targetPolicy) {
      targetPolicy = JSON.parse(docSkeleton);
    }
    // define statement list, if needed
    if (!targetPolicy.Statement || !Array.isArray(targetPolicy.Statement)) {
      targetPolicy.Statement = [];
    } else {
      // otherwise remove existing statements using our Sid
      targetPolicy.Statement = targetPolicy.Statement.filter(s => s.Sid !== Sid);
    }

    // add our updated statement
    const newStatement = JSON.parse(JSON.stringify(baseStatement));
    newStatement.Resource = newStatement.Resource.replace('__BUCKET_NAME__', targetBucket.bucketName);
    targetPolicy.Statement.push(newStatement);

    // trap and save put exceptions for later handling
    try {
      const putBucketPolicyCommand = new PutBucketPolicyCommand({
        Bucket: targetBucket.bucketName,
        ExpectedBucketOwner: awsAccountId,
        Policy: JSON.stringify(targetPolicy),
      });
      await client[targetBucket.region].send(putBucketPolicyCommand);
      updateSuccesses++;
      verbose(`Policy updated successfully for bucket ${targetBucket.bucketName}`);
    } catch(err) {
      targetBucket.putException = err;
    }
  }

  // report simple count of how many successful policy updates
  console.log(`Bucket policies updated for ${updateSuccesses} buckets`);

  // simple test of whether ANY put exceptions exist
  hasExceptions = targetBuckets.reduce(
    (res, curr) => {
      if (res) return res;
      return !!curr.putException;
    },
    false
  );

  // bail early with a report of WHICH buckets failed to update and why
  if (hasExceptions) {
    console.log('Following buckets failed to put updated bucket policy:');
    console.table(
      targetBuckets
      .filter(b => b.putException)
      .map(b => ({
          'bucket': b.bucketName,
          'put': b.putException?.toString(),
        })
      )
    );
    return;
  }

  // if no exceptions, then we're aces
  return true;
};
